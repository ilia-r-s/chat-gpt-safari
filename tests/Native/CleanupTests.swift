import XCTest
@testable import SafariChatCore

final class CleanupTests: XCTestCase {
    private let identifier = "org.safarichat.test"
    private func fixture() throws -> (base: URL, home: URL) {
        let base = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent(".build/cleanup-\(UUID().uuidString)").resolvingSymlinksInPath()
        let home = base.appendingPathComponent("Containers/\(identifier)/Data")
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library"), withIntermediateDirectories: true)
        return (base, home)
    }

    func testDirectoryLockCreatesNoFilesAndUnlocksAfterFailure() throws {
        let (base, home) = try fixture()
        defer { try? FileManager.default.removeItem(at: base) }
        let directory = home.appendingPathComponent("EmptyGroup")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try DirectoryLock.withLock(at: directory) { XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), []) }
        XCTAssertThrowsError(try DirectoryLock.withLock(at: directory) { throw ChatError.message("expected") })
        try DirectoryLock.withLock(at: directory) { XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), []) }
    }

    func testCleanupDeletesOnlyOwnedRuntimeDataAndIsIdempotent() throws {
        let (base, home) = try fixture()
        defer { try? FileManager.default.removeItem(at: base) }
        let cache = home.appendingPathComponent("Library/Caches")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
        try Data("cached".utf8).write(to: cache.appendingPathComponent("data"))
        let documents = home.appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
        let exported = documents.appendingPathComponent("saved-chat.md")
        try Data("keep".utf8).write(to: exported)
        try LocalDataCleaner.eraseFiles(home: home, bundleID: identifier)
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.path))
        XCTAssertEqual(try String(contentsOf: exported, encoding: .utf8), "keep")
        try LocalDataCleaner.eraseFiles(home: home, bundleID: identifier)
    }

    func testCleanupRejectsUnscopedHomesAndDifferentApps() {
        for path in ["/Users/test", "/Users/test/Library", "/Users/test/Library/Containers/other.app/Data"] {
            XCTAssertThrowsError(try LocalDataCleaner.locations(home: URL(fileURLWithPath: path), bundleID: identifier))
        }
    }

    func testCleanupRefusesAnAncestorSymlinkIntoAnotherDirectory() throws {
        let (base, home) = try fixture()
        defer { try? FileManager.default.removeItem(at: base) }
        let outside = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside.appendingPathComponent("Caches"), withIntermediateDirectories: true)
        let protected = outside.appendingPathComponent("Caches/keep")
        try Data("keep".utf8).write(to: protected)
        try FileManager.default.removeItem(at: home.appendingPathComponent("Library"))
        try FileManager.default.createSymbolicLink(at: home.appendingPathComponent("Library"), withDestinationURL: outside)
        XCTAssertThrowsError(try LocalDataCleaner.eraseFiles(home: home, bundleID: identifier))
        XCTAssertTrue(FileManager.default.fileExists(atPath: protected.path))
    }
}
