import XCTest
import CryptoKit
@testable import SafariChatCore

final class OAuthTests: XCTestCase {
    func testPKCEKnownVector() {
        XCTAssertEqual(OAuthAttempt.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testRegistrationAuthorizationContract() throws {
        let attempt = try OAuthAttempt(port: 54321, hostID: "urn:uuid:test")
        let items = URLComponents(url: attempt.authorizationURL(), resolvingAgainstBaseURL: false)!.queryItems!
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
        XCTAssertEqual(query["client_id"], "dynamic_agent_client")
        XCTAssertEqual(query["agent_name_hint"], "Safari Chat")
        XCTAssertEqual(query["redirect_uri"], "http://127.0.0.1:54321/auth/callback")
        XCTAssertEqual(query["resource"], "https://api.openai.com/v1")
        XCTAssertTrue(query["scope"]!.contains("chatgpt.tokens.use.direct"))
        XCTAssertNotEqual(attempt.state, attempt.nonce)
    }

    func testCallbackRejectsStateHostDuplicatesAndExpiredAttempts() throws {
        let attempt = try OAuthAttempt(port: 54321, hostID: "urn:uuid:test")
        let good = "\(attempt.redirectURI)?state=\(attempt.state)&code=code&client_id=oaiapp_test"
        XCTAssertEqual(try attempt.validateCallback(URL(string: good)!).clientID, "oaiapp_test")
        for bad in [good.replacingOccurrences(of: attempt.state, with: "wrong"), good.replacingOccurrences(of: "127.0.0.1", with: "localhost"), good + "&state=other", good + "#fragment", good.replacingOccurrences(of: "oaiapp_test", with: "dynamic_agent_client")] {
            XCTAssertThrowsError(try attempt.validateCallback(URL(string: bad)!))
        }
        XCTAssertThrowsError(try attempt.validateCallback(URL(string: good)!, now: Date().addingTimeInterval(601)))
    }

    func testReturningRegistrationDoesNotSwitchClient() throws {
        let account = Account(id: "oaiapp_original", subject: "subject", email: "a@example.com", name: "A", accessToken: nil, refreshToken: nil, idToken: "hint", expiresAt: .distantPast, scopes: [])
        let attempt = try OAuthAttempt(port: 1455, hostID: "host", account: account)
        let callback = "\(attempt.redirectURI)?state=\(attempt.state)&code=code"
        XCTAssertEqual(try attempt.validateCallback(URL(string: callback)!).clientID, account.id)
        XCTAssertThrowsError(try attempt.validateCallback(URL(string: callback + "&client_id=oaiapp_other")!))
        let query = URLComponents(url: attempt.authorizationURL(), resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertFalse(query.contains { $0.name == "agent_name_hint" })
        XCTAssertEqual(query.first { $0.name == "id_token_hint" }?.value, "hint")
    }

    func testFormEncodingDoesNotPermitParameterInjection() {
        let body = String(data: OAuthClient.form(["code": "a&b=c+ d", "client_id": "oaiapp_test"]), encoding: .utf8)!
        XCTAssertTrue(body.contains("code=a%26b%3Dc%2B%20d"))
    }

    func testCallbackPreservesTheProvidersDeclineReasonAfterValidatingState() throws {
        let attempt = try OAuthAttempt(port: 54321, hostID: "test")
        let url = URL(string: "\(attempt.redirectURI)?state=\(attempt.state)&error=access_denied&error_description=Workspace%20policy")!
        XCTAssertThrowsError(try attempt.validateCallback(url)) {
            XCTAssertEqual($0.localizedDescription, "Workspace policy (access_denied)")
        }
    }

    func testOpenAIErrorsPreferMessagesAndPreserveCodesAndHTTPStatus() {
        func reason(_ body: String, _ status: Int = 403, type: String = "application/json") -> String? {
            let http = HTTPURLResponse(url: Configuration.token, statusCode: status, httpVersion: nil,
                                       headerFields: ["x-request-id": "req_test", "Content-Type": type])!
            do { try OpenAIRequestError.requireOK(Data(body.utf8), http, redacting: ["test-credential"]); return nil }
            catch { return error.localizedDescription }
        }
        XCTAssertEqual(reason(#"{"error":{"message":"Rejected test-credential","code":2041,"param":"model"}}"#),
                       "Rejected [redacted] (2041, HTTP 403, parameter model, Request req_test)")
        XCTAssertEqual(reason(#"{"error":"invalid_grant","error_description":"This grant expired."}"#),
                       "This grant expired. (invalid_grant, HTTP 403, Request req_test)")
        XCTAssertEqual(reason(#"{"error":{"code":0}}"#, 200), "OpenAI error 0. (HTTP 200, Request req_test)")
        XCTAssertEqual(reason(#"{"error":{"code":4101,"type":"workspace_restricted"}}"#),
                       "OpenAI error workspace_restricted. (4101, HTTP 403, Request req_test)")
        XCTAssertEqual(reason("Try later", 503, type: "text/plain"), "Try later (HTTP 503, Request req_test)")
        XCTAssertEqual(reason(#"{"detail":[{"msg":"A model is required.","input":"private input"}]}"#, 422),
                       "A model is required. (HTTP 422, Request req_test)")
        XCTAssertEqual(reason("<html>gateway error</html>", 502, type: "text/html"), "HTTP 502 (Request req_test)")
    }

    @MainActor func testCallbackListenerRejectsHostAndMethodConfusion() {
        let valid = "GET /auth/callback?state=nonce&code=test HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n\r\n"
        XCTAssertNotNil(LoopbackListener.callbackURL(request: valid, port: 1234, state: "nonce"))
        for invalid in [valid.replacingOccurrences(of: "GET", with: "POST"), valid.replacingOccurrences(of: "127.0.0.1", with: "evil.example"), valid.replacingOccurrences(of: "state=nonce", with: "state=wrong"), valid.replacingOccurrences(of: "&code", with: "&state=nonce&code")] {
            XCTAssertNil(LoopbackListener.callbackURL(request: invalid, port: 1234, state: "nonce"))
        }
    }

    func testBase64URLRoundtrip() {
        let bytes = Data([0, 128, 255, 42, 8])
        XCTAssertEqual(Data(base64URL: bytes.base64URL), bytes)
        XCTAssertFalse(bytes.base64URL.contains("="))
    }
}
