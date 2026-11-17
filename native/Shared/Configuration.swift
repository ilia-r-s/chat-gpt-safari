import Foundation

enum Configuration {
    static let issuer = "https://auth.openai.com"
    static let authorize = URL(string: issuer + "/api/accounts/authorize")!
    static let token = URL(string: issuer + "/api/accounts/oauth/token")!
    static let jwks = URL(string: issuer + "/.well-known/jwks.json")!
    static let resource = "https://api.openai.com/v1"
    static let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
    static var extensionID: String { Bundle.main.object(forInfoDictionaryKey: "SafariExtensionIdentifier") as? String ?? "org.safarichat.app.Extension" }
    static let service = "org.safarichat.credentials"
}

enum ChatError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

struct Account: Codable, Identifiable, Equatable {
    var id: String
    var subject: String
    var email: String
    var name: String
    var accessToken: String?
    var refreshToken: String?
    var idToken: String?
    var expiresAt: Date
    var earliestRefreshAt: Date?
    var scopes: [String]
    var isAPIKey: Bool = false

    var canInfer: Bool { accessToken != nil && (isAPIKey || scopes.contains("chatgpt.tokens.use.direct")) }
    var label: String {
        if isAPIKey && id == "api-key" { return "Original API key" }
        return "\(email.isEmpty ? name : email) · \(id.suffix(6))"
    }
}

struct Vault: Codable {
    var hostID = "urn:uuid:\(UUID().uuidString.lowercased())"
    var activeID: String?
    private(set) var sessionID: String?
    var accounts: [Account] = []
    var desktopBridges: [DesktopLease]?
    var desktopProfileID: String?
    var active: Account? { accounts.first { $0.id == activeID } }
    var generation: String { sessionID ?? activeID ?? "local" }

    mutating func activate(_ id: String?) {
        activeID = id
        sessionID = UUID().uuidString.lowercased()
    }

    mutating func connectKey(_ key: String, name: String, replacing id: String?) throws {
        if let id {
            guard let index = accounts.firstIndex(where: { $0.id == id && $0.isAPIKey }) else {
                throw ChatError.message("This key connection was removed. Add a new connection.")
            }
            accounts[index].accessToken = key
            activate(id)
        } else {
            let id = "key-" + UUID().uuidString.lowercased()
            let title = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
            accounts.append(Account(id: id, subject: id, email: "", name: title.isEmpty ? "API key" : title,
                                    accessToken: key, refreshToken: nil, idToken: nil, expiresAt: .distantFuture, scopes: [], isAPIKey: true))
            activate(id)
        }
    }

    mutating func beginSignOut(expected: String) throws -> Account {
        guard generation == expected, let index = accounts.firstIndex(where: { $0.id == activeID }) else {
            throw ChatError.message("The selected account changed. Check the account before signing out.")
        }
        let account = accounts[index]
        accounts[index].accessToken = nil
        accounts[index].refreshToken = nil
        accounts[index].idToken = nil
        accounts[index].scopes = []
        activate(nil)
        return account
    }

}

extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    init?(base64URL: String) {
        let value = base64URL.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        self.init(base64Encoded: value + String(repeating: "=", count: (4 - value.count % 4) % 4))
    }
}
