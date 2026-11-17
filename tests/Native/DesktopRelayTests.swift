import Foundation
import XCTest
@testable import SafariChatCore

@MainActor
final class DesktopRelayTests: XCTestCase {
    private let token = String(repeating: "a", count: 64)
    private func request(body: String = "{}", extra: String = "", authorization: String? = nil) -> Data {
        Data("POST /reply HTTP/1.1\r\nHost: 127.0.0.1:43210\r\nAuthorization: Bearer \(authorization ?? token)\r\nContent-Length: \(body.utf8.count)\r\n\(extra)\r\n\(body)".utf8)
    }
    func testInboxRequiresSecretAndExactLoopbackFraming() throws {
        XCTAssertEqual(try DesktopHTTP.body(request(), port: 43210, token: token), Data("{}".utf8))
        XCTAssertNil(try DesktopHTTP.body(Data(request().dropLast()), port: 43210, token: token))
        for invalid in [request(authorization: "wrong"), request(extra: "Origin: https://evil.example\r\n"), request(extra: "Content-Length: 2\r\n"), request(extra: "Transfer-Encoding: chunked\r\n"), request() + Data("extra".utf8)] {
            XCTAssertThrowsError(try DesktopHTTP.body(invalid, port: 43210, token: token))
        }
        XCTAssertThrowsError(try DesktopHTTP.body(request(), port: 9999, token: token))
        XCTAssertThrowsError(try DesktopHTTP.body(Data(repeating: 65, count: 266385), port: 43210, token: token))
    }
    func testLeasesExpireAndOldVaultsRemainDecodable() throws {
        let old = Data(#"{"hostID":"host","accounts":[]}"#.utf8)
        let legacy = try JSONDecoder().decode(Vault.self, from: old)
        XCTAssertNil(legacy.desktopBridges)
        let id = UUID().uuidString
        var vault = Vault()
        vault.desktopBridges = [DesktopLease(id: id, token: token, port: 43210, expires: Date().addingTimeInterval(60), profileID: "profile")]
        XCTAssertEqual(try DesktopRelay.lease(id, vault: vault).port, 43210)
        XCTAssertThrowsError(try DesktopRelay.lease(id, vault: vault, now: Date().addingTimeInterval(61)))
        XCTAssertThrowsError(try DesktopRelay.lease(UUID().uuidString, vault: vault))
    }
    func testDesktopControlIsBoundToOneOSProvidedProfile() throws {
        let profile = UUID()
        XCTAssertEqual(try DesktopRelay.profileIdentifier(profile), profile.uuidString.lowercased())
        XCTAssertEqual(try DesktopRelay.profileIdentifier(profile.uuidString), profile.uuidString.lowercased())
        XCTAssertEqual(try DesktopRelay.profileIdentifier(nil), "default")
        XCTAssertThrowsError(try DesktopRelay.profileIdentifier("not-an-id"))
        let id = UUID().uuidString
        var vault = Vault()
        vault.desktopProfileID = "profile-a"
        vault.desktopBridges = [DesktopLease(id: id, token: token, port: 43210, expires: Date().addingTimeInterval(60), profileID: "profile-a")]
        XCTAssertNoThrow(try DesktopRelay.authorizedLease(id, vault: vault, profileID: "profile-a"))
        XCTAssertThrowsError(try DesktopRelay.authorizedLease(id, vault: vault, profileID: "profile-b"))
        vault.desktopProfileID = "profile-b"
        XCTAssertThrowsError(try DesktopRelay.authorizedLease(id, vault: vault, profileID: "profile-a"))
        XCTAssertNoThrow(try DesktopRelay.authorizedLease(id, vault: vault, profileID: "profile-a", requireEnabled: false), "the old client can still receive its cancellation/error")
    }
    func testApprovalRequiresAcceptAndALiteralBoolean() throws {
        for (json, expected) in [
            (#"{"action":"accept","content":{"approve":true}}"#, true),
            (#"{"action":"accept","content":{"approve":false}}"#, false),
            (#"{"action":"accept","content":{"approve":1}}"#, false),
            (#"{"action":"accept","content":{"approve":"true"}}"#, false),
            (#"{"action":"cancel","content":{"approve":true}}"#, false),
            (#"{"action":"accept"}"#, false)
        ] {
            let response = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
            XCTAssertEqual(DesktopApproval.accepts(response), expected)
        }
        XCTAssertFalse(DesktopApproval.accepts(nil))
    }
}
