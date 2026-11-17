import Foundation
import XCTest
@testable import SafariChatCore

final class CompanionAppTests: XCTestCase {
    func testDirectSignInOnlyAcceptsTheFixedActionWithoutCallerParameters() {
        XCTAssertTrue(CompanionApp.isSignInURL(CompanionApp.signInURL))
        for value in ["safarichat://connect", "safarichat://signin?redirect=https://evil.example", "safarichat://signin/path", "safarichat://user@signin", "https://signin", "safarichat://signin#payload"] {
            XCTAssertFalse(CompanionApp.isSignInURL(URL(string: value)!))
        }
    }
    func testResolvesOwnCompanionWithCustomizedBundleIdentifier() throws {
        let path = URL(fileURLWithPath: "/Applications/Safari Chat.app/Contents/PlugIns/Safari Chat Extension.appex")
        let app = try CompanionApp.applicationURL(extensionURL: path, extensionIdentifier: "com.example.chat.Extension")
        XCTAssertEqual(app.path, "/Applications/Safari Chat.app")
    }

    func testRequiresTheNativeExtensionIdentity() {
        let path = URL(fileURLWithPath: "/Applications/Safari Chat.app/Contents/PlugIns/Safari Chat Extension.appex")
        for identifier: String? in [nil, ".Extension", "com.example.chat"] {
            XCTAssertThrowsError(try CompanionApp.applicationURL(extensionURL: path, extensionIdentifier: identifier))
        }
    }

    func testResolvesXcodeBuildWithoutReadingParentMetadataOrAppRegistry() throws {
        let app = URL(fileURLWithPath: "/inaccessible/DerivedData/Build/Products/Debug/Safari Chat.app")
        let path = app.appendingPathComponent("Contents/PlugIns/Safari Chat Extension.appex")
        let resolved = try CompanionApp.applicationURL(extensionURL: path, extensionIdentifier: "com.example.chat.Extension")
        XCTAssertEqual(resolved.path, app.path)
    }

    func testRefusesLooseExtensionAndRemoteOrUnexpectedBundleLocations() {
        for path in ["/tmp/Safari Chat Extension.appex", "/Applications/Safari Chat.app/Contents/Resources/Extension.appex",
                     "/Applications/Safari Chat.app/Contents/PlugIns/not-an-extension", "/tmp/Contents/PlugIns/Extension.appex"] {
            XCTAssertThrowsError(try CompanionApp.applicationURL(extensionURL: URL(fileURLWithPath: path), extensionIdentifier: "com.example.chat.Extension"))
        }
        XCTAssertThrowsError(try CompanionApp.applicationURL(extensionURL: URL(string: "https://example.com/App.app/Contents/PlugIns/Extension.appex")!, extensionIdentifier: "com.example.chat.Extension"))
    }
}
