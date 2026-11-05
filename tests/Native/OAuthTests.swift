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
