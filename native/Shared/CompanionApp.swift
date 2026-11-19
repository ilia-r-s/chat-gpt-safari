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

    enum Action: String {
        case signIn = "signin", apiKey = "api-key"

        var url: URL { URL(string: "safarichat://\(rawValue)")! }

        init?(url: URL) {
            guard url.scheme == "safarichat", let host = url.host, url.path.isEmpty,
                  url.query == nil, url.fragment == nil, url.user == nil, url.password == nil, url.port == nil else { return nil }
            self.init(rawValue: host)
        }
    }

    @MainActor static func open(extensionBundle: Bundle, action: Action? = nil) async throws {
        let app = try applicationURL(extensionURL: extensionBundle.bundleURL, extensionIdentifier: extensionBundle.bundleIdentifier)
        let options = NSWorkspace.OpenConfiguration()
        options.activates = action != .signIn
        options.addsToRecentItems = false
        do {
            if let action { _ = try await NSWorkspace.shared.open([action.url], withApplicationAt: app, configuration: options) }
            else { _ = try await NSWorkspace.shared.openApplication(at: app, configuration: options) }
        }
        catch { throw ChatError.message("macOS could not open Safari Chat. Open Safari Chat.app from Finder or run it from Xcode, then try again. \(error.localizedDescription)") }
    }
}
