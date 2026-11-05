import AppKit
import Foundation

enum CompanionApp {
    /// Resolve only the app embedding this extension; never accept a path from JavaScript.
    static func applicationURL(extensionURL: URL, extensionIdentifier: String?,
                               identifier: (URL) -> String? = { Bundle(url: $0)?.bundleIdentifier }) throws -> URL {
        let extensionRoot = extensionURL.standardizedFileURL
        let plugins = extensionRoot.deletingLastPathComponent()
        let contents = plugins.deletingLastPathComponent()
        let app = contents.deletingLastPathComponent()
        guard extensionURL.isFileURL, extensionRoot.pathExtension == "appex",
              plugins.lastPathComponent == "PlugIns", contents.lastPathComponent == "Contents",
              app.pathExtension == "app", let extensionIdentifier,
              extensionIdentifier.hasSuffix(".Extension"),
              identifier(app) == String(extensionIdentifier.dropLast(".Extension".count)) else {
            throw ChatError.message("Could not locate the Safari Chat companion app. Open Safari Chat.app from Finder, then enable the extension included with that app.")
        }
        return app
    }

    @MainActor static func open() async throws {
        let app = try applicationURL(extensionURL: Bundle.main.bundleURL, extensionIdentifier: Bundle.main.bundleIdentifier)
        let options = NSWorkspace.OpenConfiguration()
        options.activates = true
        options.addsToRecentItems = false
        do { _ = try await NSWorkspace.shared.openApplication(at: app, configuration: options) }
        catch { throw ChatError.message("macOS could not open Safari Chat. Open Safari Chat.app from Finder or run it from Xcode, then try again. \(error.localizedDescription)") }
    }
}
