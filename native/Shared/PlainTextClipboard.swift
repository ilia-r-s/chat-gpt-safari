import AppKit

enum PlainTextClipboard {
    static let limit = 24_000

    @MainActor static func read(from board: NSPasteboard, verify: () throws -> Void) throws -> String {
        try verify()
        guard let text = board.string(forType: .string), text.utf16.count <= limit else {
            throw ChatError.message("The clipboard must contain plain text of at most 24,000 characters.")
        }
        try verify()
        return text
    }

    @MainActor static func write(_ text: String, to board: NSPasteboard, verify: () throws -> Void) throws {
        let item = NSPasteboardItem()
        guard text.utf16.count <= limit, item.setString(text, forType: .string) else {
            throw ChatError.message("Copy at most 24,000 characters at a time.")
        }
        try verify()
        board.clearContents()
        guard board.writeObjects([item]) else { throw ChatError.message("macOS could not write the clipboard.") }
    }
}
