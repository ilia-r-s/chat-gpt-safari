import Foundation
import XCTest
@testable import SafariChatCore

final class CompanionAppTests: XCTestCase {
    func testResolvesOwnCompanionWithCustomizedBundleIdentifier() throws {
        let path = URL(fileURLWithPath: "/Applications/Safari Chat.app/Contents/PlugIns/Safari Chat Extension.appex")
        let app = try CompanionApp.applicationURL(extensionURL: path, extensionIdentifier: "com.example.chat.Extension") { _ in "com.example.chat" }
        XCTAssertEqual(app.path, "/Applications/Safari Chat.app")
    }

    func testRefusesMissingOrDifferentCompanionIdentity() {
        let path = URL(fileURLWithPath: "/Applications/Other.app/Contents/PlugIns/Safari Chat Extension.appex")
        for identity: String? in [nil, "com.example.other"] {
            XCTAssertThrowsError(try CompanionApp.applicationURL(extensionURL: path, extensionIdentifier: "com.example.chat.Extension") { _ in identity })
        }
        XCTAssertThrowsError(try CompanionApp.applicationURL(extensionURL: path, extensionIdentifier: nil))
    }

    func testRefusesLooseExtensionAndRemoteOrUnexpectedBundleLocations() {
        for path in ["/tmp/Safari Chat Extension.appex", "/Applications/Safari Chat.app/Contents/Resources/Extension.appex",
                     "/Applications/Safari Chat.app/Contents/PlugIns/not-an-extension", "/tmp/Contents/PlugIns/Extension.appex"] {
            XCTAssertThrowsError(try CompanionApp.applicationURL(extensionURL: URL(fileURLWithPath: path), extensionIdentifier: "com.example.chat.Extension") { _ in "com.example.chat" })
        }
        XCTAssertThrowsError(try CompanionApp.applicationURL(extensionURL: URL(string: "https://example.com/App.app/Contents/PlugIns/Extension.appex")!, extensionIdentifier: "com.example.chat.Extension") { _ in "com.example.chat" })
    }
}
