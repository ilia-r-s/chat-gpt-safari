import Foundation

/// Only removes known runtime data inside this process's verified sandbox container.
/// It never removes a container root, user exports, Safari's files, or system records.
enum LocalDataCleaner {
    static func locations(home: URL, bundleID: String) throws -> [URL] {
        let root = home.standardizedFileURL
        guard !bundleID.isEmpty, !bundleID.contains("/"), !bundleID.contains(".."),
              root.lastPathComponent == "Data",
              root.deletingLastPathComponent().lastPathComponent == bundleID,
              root.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent == "Containers" else {
            throw ChatError.message("Native cleanup requires the app's verified sandbox container. No files were removed.")
        }
        return ["Library/Caches", "Library/HTTPStorages", "Library/WebKit", "Library/Saved Application State",
                "Library/Preferences/\(bundleID).plist"].map { root.appendingPathComponent($0) }
    }

    static func eraseFiles(home: URL, bundleID: String, fileManager: FileManager = .default) throws {
        let root = home.standardizedFileURL
        let targets = try locations(home: root, bundleID: bundleID)
        guard root.resolvingSymlinksInPath().path == root.path else {
            throw ChatError.message("Native cleanup refused a redirected container path.")
        }
        var failures: [String] = []
        for target in targets {
            do {
                // Ancestors may not redirect deletion into Downloads, Safari, or another container.
                var ancestor = target.deletingLastPathComponent()
                while ancestor.path != root.path {
                    if try ancestor.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
                        throw ChatError.message("A cleanup folder is a symbolic link.")
                    }
                    ancestor.deleteLastPathComponent()
                }
                try fileManager.removeItem(at: target) // A final symlink itself is removed, never followed.
            } catch let error as CocoaError where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile { }
            catch { failures.append(target.lastPathComponent) }
        }
        if !failures.isEmpty { throw ChatError.message("Could not remove native data: \(failures.joined(separator: ", ")). Quit the app and retry cleanup.") }
    }

    static func eraseCurrentProcess() throws {
        guard let bundleID = Bundle.main.bundleIdentifier else { throw ChatError.message("The app bundle identifier is unavailable.") }
        let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        _ = try locations(home: home, bundleID: bundleID) // Check scope before touching preferences/caches.
        URLCache.shared.removeAllCachedResponses()
        UserDefaults.standard.removePersistentDomain(forName: bundleID)
        UserDefaults.standard.synchronize()
        try eraseFiles(home: home, bundleID: bundleID)
    }
}
