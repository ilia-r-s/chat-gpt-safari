import XCTest
import CryptoKit
@testable import SafariChatCore

final class IdentityTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1700000000)
    func claims(_ override: [String: Any] = [:]) -> [String: Any] {
        var values: [String: Any] = ["iss": Configuration.issuer, "aud": "oaiapp_test", "sub": "subject", "nonce": "nonce", "exp": now.timeIntervalSince1970 + 3600, "email": "me@example.com"]
        values.merge(override) { _, new in new }; return values
    }
    func testSignedTokenIsVerifiedAndTamperingFails() throws {
        let privateKey = P256.Signing.PrivateKey()
        let publicKey = privateKey.publicKey.x963Representation
        let jwk: [String: Any] = ["kid": "test", "kty": "EC", "crv": "P-256", "alg": "ES256", "x": publicKey.subdata(in: 1..<33).base64URL, "y": publicKey.subdata(in: 33..<65).base64URL]
        let header = try JSONSerialization.data(withJSONObject: ["alg": "ES256", "kid": "test"]).base64URL
        let body = try JSONSerialization.data(withJSONObject: claims()).base64URL
        let signed = "\(header).\(body)"
        let signature = try privateKey.signature(for: Data(signed.utf8)).rawRepresentation.base64URL
        let token = "\(signed).\(signature)"
        XCTAssertEqual(try IDToken.verify(token, keys: [jwk], audience: "oaiapp_test", nonce: "nonce", now: now).subject, "subject")
        let tampered = try JSONSerialization.data(withJSONObject: claims(["sub": "attacker"])).base64URL
        XCTAssertThrowsError(try IDToken.verify("\(header).\(tampered).\(signature)", keys: [jwk], audience: "oaiapp_test", nonce: "nonce", now: now))
        XCTAssertThrowsError(try IDToken.verify(token, keys: [jwk], audience: "oaiapp_other", nonce: "nonce", now: now))
        XCTAssertThrowsError(try IDToken.verify(token, keys: [jwk], audience: "oaiapp_test", nonce: "wrong", now: now))
    }
    func testInvalidClaimsAreRejected() throws {
        for invalid: [String: Any] in [["iss": "https://attacker.example"], ["aud": "other"], ["exp": now.timeIntervalSince1970 - 1], ["nonce": "wrong"], ["sub": ""], ["nbf": now.timeIntervalSince1970 + 1000], ["azp": "other"], ["aud": ["oaiapp_test", "other"]]] {
            XCTAssertThrowsError(try IDToken.validateClaims(JSONSerialization.data(withJSONObject: claims(invalid)), audience: "oaiapp_test", nonce: "nonce", now: now))
        }
    }
    func testUnsignedTokensCannotAuthenticate() throws {
        let header = try JSONSerialization.data(withJSONObject: ["alg": "none", "kid": "test"]).base64URL
        let body = try JSONSerialization.data(withJSONObject: claims()).base64URL
        XCTAssertThrowsError(try IDToken.verify("\(header).\(body).", keys: [], audience: "oaiapp_test", nonce: "nonce", now: now))
    }
    func testIdentityAloneDoesNotEnablePlanUsage() {
        var account = Account(id: "id", subject: "s", email: "", name: "Name", accessToken: "token", refreshToken: nil, idToken: "id", expiresAt: .distantFuture, scopes: ["openid"])
        XCTAssertFalse(account.canInfer)
        account.scopes.append("chatgpt.tokens.use.direct")
        XCTAssertTrue(account.canInfer)
        account.accessToken = nil
        XCTAssertFalse(account.canInfer)
    }

    func testRS256SignatureWithKnownFixture() throws {
        let jwk: [String: Any] = ["kid": "rsa", "kty": "RSA", "alg": "RS256", "n": RSAFixture.modulus, "e": RSAFixture.exponent]
        XCTAssertEqual(try IDToken.verify(RSAFixture.token, keys: [jwk], audience: "oaiapp_test", nonce: "nonce", now: now).subject, "subject")
        XCTAssertThrowsError(try IDToken.verify(RSAFixture.token, keys: [jwk], audience: "wrong", nonce: "nonce", now: now))
    }
}
