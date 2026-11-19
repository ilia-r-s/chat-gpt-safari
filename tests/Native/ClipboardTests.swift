import AppKit
import XCTest
@testable import SafariChatCore

final class ClipboardTests: XCTestCase {
    @MainActor func testPlainTextUsesOnlyTheSuppliedPasteboardAndChecksTheSession() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        try XCTSkipUnless(board.setString("fixture", forType: .string), "This environment cannot access the macOS pasteboard service.")
        let value = "Selected 🖋 text\nfrom the page"
        try PlainTextClipboard.write(value, to: board, verify: {})
        XCTAssertEqual(try PlainTextClipboard.read(from: board, verify: {}), value)
        XCTAssertThrowsError(try PlainTextClipboard.write("lost", to: board) { throw ChatError.message("Account changed") })
        XCTAssertThrowsError(try PlainTextClipboard.write(String(repeating: "a", count: 24_001), to: board, verify: {}))
        XCTAssertEqual(board.string(forType: .string), value)
        var checks = 0
        XCTAssertThrowsError(try PlainTextClipboard.read(from: board) {
            checks += 1
            if checks == 2 { throw ChatError.message("Account changed") }
        })
    }
}
