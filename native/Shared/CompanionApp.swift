import AppKit
import Foundation

enum CompanionApp {
    /// Resolve only the app embedding this extension; never accept a path from JavaScript.
    static func applicationURL(extensionURL: URL, extensionIdentifier: String?) throws -> URL {
        let extensionRoot = extensionURL.standardizedFileURL
        let plugins = extensionRoot.deletingLastPathComponent()
        let contents = plugins.deletingLastPathComponent()
        let app = contents.deletingLastPathComponent()
        guard extensionURL.isFileURL, extensionRoot.pathExtension == "appex",
              plugins.lastPathComponent == "PlugIns", contents.lastPathComponent == "Contents",
              app.pathExtension == "app", let extensionIdentifier,
              extensionIdentifier.hasSuffix(".Extension"), extensionIdentifier.count > ".Extension".count else {
            throw ChatError.message("Safari Chat is not running from its packaged extension. Run the Safari Chat app from Xcode, then enable the extension included with that app.")
        }
        // The OS-loaded handler bundle is our source of truth. Reading the parent
        // Info.plist can fail in the extension sandbox, and Launch Services can
        // omit this Xcode build or choose an older copy with the same identifier.
        // Neither is needed to open the app that physically embeds this handler.
        return app
    }

    static let signInURL = URL(string: "safarichat://signin")!

    static func isSignInURL(_ url: URL) -> Bool {
        url.scheme == "safarichat" && url.host == "signin" && url.path.isEmpty && url.query == nil && url.fragment == nil && url.user == nil && url.password == nil && url.port == nil
    }

    @MainActor static func open(extensionBundle: Bundle, signIn: Bool = false) async throws {
        let app = try applicationURL(extensionURL: extensionBundle.bundleURL, extensionIdentifier: extensionBundle.bundleIdentifier)
        let options = NSWorkspace.OpenConfiguration()
        options.activates = !signIn
        options.addsToRecentItems = false
        do {
            if signIn { _ = try await NSWorkspace.shared.open([signInURL], withApplicationAt: app, configuration: options) }
            else { _ = try await NSWorkspace.shared.openApplication(at: app, configuration: options) }
        }
        catch { throw ChatError.message("macOS could not open Safari Chat. Open Safari Chat.app from Finder or run it from Xcode, then try again. \(error.localizedDescription)") }
    }
}
