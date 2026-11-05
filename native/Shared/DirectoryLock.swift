import Foundation
import Darwin

enum DirectoryLock {
    static func withLock<T>(at directory: URL, _ operation: () throws -> T) throws -> T {
        let descriptor = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw ChatError.message("Could not open account coordination storage.") }
        defer { flock(descriptor, LOCK_UN); close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else { throw ChatError.message("Could not lock account storage.") }
        return try operation()
    }
}
