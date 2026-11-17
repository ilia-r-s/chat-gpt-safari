import XCTest
@testable import SafariChatCore

final class AccountSessionTests: XCTestCase {
    func testLegacyKeyHistoryAndExplicitReplacement() throws {
        var vault = try JSONDecoder().decode(Vault.self, from: Data(#"{"hostID":"mac","activeID":"api-key","accounts":[]}"#.utf8))
        vault.accounts = [Account(id: "api-key", subject: "legacy", email: "", name: "API key", accessToken: "old",
                                  expiresAt: .distantFuture, scopes: [], isAPIKey: true)]
        XCTAssertEqual(vault.generation, "api-key")
        try vault.connectKey("first", name: " Work ", replacing: nil)
        let work = try XCTUnwrap(vault.active)
        let session = vault.generation
        XCTAssertEqual(work.name, "Work")
        try vault.connectKey("first", name: "", replacing: nil)
        XCTAssertNotEqual(vault.activeID, work.id)
        try vault.connectKey("rotated", name: "", replacing: work.id)
        XCTAssertEqual(vault.activeID, work.id)
        XCTAssertEqual(vault.active?.accessToken, "rotated")
        XCTAssertNotEqual(vault.generation, session)
        try vault.connectKey("legacy replacement", name: "", replacing: "api-key")
        XCTAssertEqual(vault.active?.label, "Original API key")
        XCTAssertEqual(vault.accounts.count, 3)
        XCTAssertThrowsError(try vault.connectKey("secret", name: "", replacing: "removed"))
        XCTAssertEqual(vault.activeID, "api-key")
        XCTAssertEqual(try JSONDecoder().decode(Vault.self, from: JSONEncoder().encode(vault)).generation, vault.generation)
    }

    func testSignOutDetachesOnlyTheExpectedSession() throws {
        var vault = Vault()
        try vault.connectKey("other", name: "Other", replacing: nil)
        let other = try XCTUnwrap(vault.active)
        let account = Account(id: "issued", subject: "subject", email: "", name: "OAuth", accessToken: "access",
                              refreshToken: "refresh", idToken: "identity", expiresAt: .distantFuture, scopes: ["openid"])
        vault.accounts.append(account); vault.activate(account.id)
        let original = vault.generation
        vault.activate(other.id); vault.activate(account.id)
        XCTAssertThrowsError(try vault.beginSignOut(expected: original))
        let current = vault.generation
        let retiring = try vault.beginSignOut(expected: current)
        XCTAssertEqual(retiring.refreshToken, "refresh")
        XCTAssertNil(vault.active); XCTAssertNotEqual(vault.generation, current)
        XCTAssertEqual(vault.accounts[0], other)
        XCTAssertNil(vault.accounts[1].accessToken); XCTAssertNil(vault.accounts[1].refreshToken)
        XCTAssertNil(vault.accounts[1].idToken); XCTAssertTrue(vault.accounts[1].scopes.isEmpty)
        XCTAssertThrowsError(try vault.beginSignOut(expected: current))
    }

    func testDesktopOptInPreflightIsReadOnly() throws {
        var calls = 0
        var vault = Vault()
        XCTAssertThrowsError(try DesktopRelay.enabledProfile { calls += 1; return vault })
        vault.desktopProfileID = "profile"
        let (original, profile) = try DesktopRelay.enabledProfile { calls += 1; return vault }
        XCTAssertEqual(calls, 2); XCTAssertEqual(profile, "profile")
        XCTAssertEqual(original.hostID, vault.hostID); XCTAssertNil(original.desktopBridges)
    }

    func testRevocationUsesDiscoveredEndpointAndRetriesTransientFailure() async throws {
        let address = Configuration.issuer + "/example/revoke"
        var posts = 0, discoveries = 0
        let revoked = await OAuthClient.revoke(token: "retiring&token", clientID: "issued", send: { request in
            let url = try XCTUnwrap(request.url)
            var data = Data(), status = 200
            if request.httpMethod == "GET" {
                discoveries += 1
                XCTAssertEqual(url.absoluteString, Configuration.issuer + "/.well-known/openid-configuration")
                XCTAssertNil(request.httpBody)
                data = try JSONSerialization.data(withJSONObject: ["issuer": Configuration.issuer, "revocation_endpoint": address])
            } else {
                posts += 1; status = posts == 1 ? 503 : 200
                XCTAssertEqual(url.absoluteString, address); XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/x-www-form-urlencoded")
                XCTAssertEqual(request.httpBody, OAuthClient.form(["client_id": "issued", "token": "retiring&token", "token_type_hint": "refresh_token"]))
            }
            return (data, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }, backoff: .zero)
        XCTAssertTrue(revoked); XCTAssertEqual(discoveries, 1); XCTAssertEqual(posts, 2)
    }

    func testRevocationRejectsUntrustedDiscoveryAndReportsOfflineFailure() async {
        let refused = await OAuthClient.revoke(token: "retiring", clientID: "issued", send: { request in
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody)
            let metadata = ["issuer": Configuration.issuer, "revocation_endpoint": "https://example.org/revoke"]
            return (try JSONSerialization.data(withJSONObject: metadata), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, backoff: .zero)
        XCTAssertFalse(refused)
        var attempts = 0
        let offline = await OAuthClient.revoke(token: "retiring", clientID: "issued", send: { _ in
            attempts += 1; throw URLError(.notConnectedToInternet)
        }, backoff: .zero)
        XCTAssertFalse(offline); XCTAssertEqual(attempts, 2)
    }
}
