import Foundation
import CryptoKit
import Security

struct OAuthAttempt {
    let state: String
    let nonce: String
    let verifier: String
    let redirectURI: String
    let hostID: String
    let account: Account?
    let created: Date

    init(port: UInt16, hostID: String, account: Account? = nil) throws {
        state = try Self.random(); nonce = try Self.random(); verifier = try Self.random(bytes: 64)
        redirectURI = "http://127.0.0.1:\(port)/auth/callback"
        self.hostID = hostID; self.account = account; created = Date()
    }

    static func random(bytes: Int = 32) throws -> String {
        var data = [UInt8](repeating: 0, count: bytes)
        guard SecRandomCopyBytes(kSecRandomDefault, data.count, &data) == errSecSuccess else { throw ChatError.message("Could not generate secure sign-in state.") }
        return Data(data).base64URL
    }

    static func challenge(_ verifier: String) -> String { Data(SHA256.hash(data: Data(verifier.utf8))).base64URL }

    func authorizationURL() -> URL {
        var parts = URLComponents(url: Configuration.authorize, resolvingAgainstBaseURL: false)!
        var values = ["client_id": account?.id ?? "dynamic_agent_client", "ext_agent_host_id": hostID,
                      "response_type": "code", "redirect_uri": redirectURI, "scope": Configuration.scopes,
                      "resource": Configuration.resource, "state": state, "nonce": nonce,
                      "code_challenge_method": "S256", "code_challenge": Self.challenge(verifier)]
        if let account {
            if let hint = account.idToken { values["id_token_hint"] = hint }
            if !account.email.isEmpty { values["login_hint"] = account.email }
        } else { values["agent_name_hint"] = "Safari Chat" }
        parts.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return parts.url!
    }

    func validateCallback(_ url: URL, now: Date = Date()) throws -> (code: String, clientID: String) {
        guard now.timeIntervalSince(created) < 600,
              url.scheme == "http", url.host == "127.0.0.1", url.port == URL(string: redirectURI)?.port,
              url.path == "/auth/callback", url.user == nil, url.password == nil, url.fragment == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else {
            throw ChatError.message("This sign-in attempt expired or returned to an unexpected address. Please try again.")
        }
        let names = items.map(\.name)
        guard Set(names).count == names.count else { throw ChatError.message("The sign-in callback contained duplicate parameters.") }
        let fields = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard fields["state"] == state else { throw ChatError.message("The sign-in state did not match. Please try again.") }
        if let error = fields["error"] { throw ChatError.message(error == "access_denied" ? "Sign-in was cancelled. You can try again at any time." : "OpenAI could not authorize this sign-in.") }
        guard let code = fields["code"], !code.isEmpty else { throw ChatError.message("OpenAI did not return an authorization code.") }
        let clientID = fields["client_id"] ?? account?.id
        guard let clientID, clientID.hasPrefix("oaiapp_"), clientID.count < 256 else { throw ChatError.message("OpenAI did not return a valid client registration.") }
        if let account, clientID != account.id { throw ChatError.message("The callback belongs to a different account registration.") }
        return (code, clientID)
    }
}

struct TokenResponse: Decodable {
    var access_token: String
    var refresh_token: String?
    var id_token: String?
    var token_type: String
    var expires_in: Double
    var scope: String?
    var earliest_refresh_at: Double?
}

enum OAuthClient {
    static func form(_ fields: [String: String]) -> Data {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return Data(fields.sorted { $0.key < $1.key }.map { key, value in
            "\(key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\(value.addingPercentEncoding(withAllowedCharacters: allowed)!)"
        }.joined(separator: "&").utf8)
    }

    static func exchange(_ fields: [String: String]) async throws -> TokenResponse {
        var request = URLRequest(url: Configuration.token)
        request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = form(fields)
        let (data, response) = try await SecureHTTP.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw ChatError.message("OpenAI could not complete sign-in (HTTP \(status)). Please sign in again.")
        }
        let token = try JSONDecoder().decode(TokenResponse.self, from: data)
        guard token.token_type.lowercased() == "bearer", !token.access_token.isEmpty, token.expires_in > 0 else { throw ChatError.message("OpenAI returned an invalid token response.") }
        return token
    }

    static func finish(_ attempt: OAuthAttempt, callback: URL) async throws -> Account {
        let values = try attempt.validateCallback(callback)
        let token = try await exchange(["grant_type": "authorization_code", "client_id": values.clientID,
            "code": values.code, "code_verifier": attempt.verifier, "redirect_uri": attempt.redirectURI, "resource": Configuration.resource])
        guard let idToken = token.id_token else { throw ChatError.message("OpenAI did not provide an identity token.") }
        let claims = try await IDToken.validate(idToken, audience: values.clientID, nonce: attempt.nonce)
        if let previous = attempt.account, previous.subject != claims.subject { throw ChatError.message("This sign-in belongs to a different account. Add it as a new account instead.") }
        return Account(id: values.clientID, subject: claims.subject, email: claims.email, name: claims.name,
            accessToken: token.access_token, refreshToken: token.refresh_token, idToken: idToken,
            expiresAt: Date().addingTimeInterval(token.expires_in),
            earliestRefreshAt: token.earliest_refresh_at.map { Date(timeIntervalSince1970: $0) },
            scopes: (token.scope ?? "").split(separator: " ").map(String.init))
    }
}

final class RedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum SecureHTTP {
    static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration, delegate: RedirectBlocker(), delegateQueue: nil)
    }()
}
