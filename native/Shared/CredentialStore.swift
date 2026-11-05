import Foundation
import Security

/// One encrypted Keychain record; a directory lock coordinates processes without a lock file.
enum CredentialStore {
    private static func query() throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SharedKeychainGroup") as? String,
              !group.isEmpty, !group.contains("$(") else {
            throw ChatError.message("The app needs to be signed with Keychain Sharing enabled. See the installation guide.")
        }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Configuration.service,
                kSecAttrAccount as String: "vault-v1",
                kSecAttrAccessGroup as String: group,
                kSecUseDataProtectionKeychain as String: true]
    }

    private static func groupDirectory() throws -> URL {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "SharedAppGroup") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw ChatError.message("Shared app storage is unavailable. Check the app's signing and App Groups configuration.")
        }
        return directory
    }

    private static func locked<T>(_ body: () throws -> T) throws -> T {
        try DirectoryLock.withLock(at: groupDirectory(), body)
    }

    private static func readUnlocked() throws -> Vault {
        var request = try query()
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return Vault() }
        guard status == errSecSuccess, let data = result as? Data else { throw keychainError(status) }
        return try JSONDecoder().decode(Vault.self, from: data)
    }

    private static func writeUnlocked(_ vault: Vault) throws {
        let data = try JSONEncoder().encode(vault)
        let request = try query()
        var status = SecItemUpdate(request as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var insert = request
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw keychainError(status) }
    }

    // Keychain reads are atomic and do not need to create or open a group container.
    static func read() throws -> Vault { try readUnlocked() }

    @discardableResult
    static func update(_ mutation: (inout Vault) throws -> Void) throws -> Vault {
        try locked {
            var vault = try readUnlocked()
            try mutation(&vault)
            try writeUnlocked(vault)
            return vault
        }
    }

    static func signOut() throws {
        try update { vault in
            guard vault.activeID != nil else { throw ChatError.message("No account is signed in.") }
            if let index = vault.accounts.firstIndex(where: { $0.id == vault.activeID }) {
                vault.accounts[index].accessToken = nil
                vault.accounts[index].refreshToken = nil
                vault.accounts[index].idToken = nil
                vault.accounts[index].scopes = []
            }
            vault.activeID = nil
        }
    }

    static func eraseAll() throws {
        try locked {
            let request = try query()
            let status = SecItemDelete(request as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError(status) }
            var verify = request
            verify[kSecMatchLimit as String] = kSecMatchLimitOne
            let remaining = SecItemCopyMatching(verify as CFDictionary, nil)
            guard remaining == errSecItemNotFound else { throw ChatError.message("Could not verify that saved credentials were erased (Keychain \(remaining)).") }
            // Previous development builds created this file; current builds never do.
            let legacy = try groupDirectory().appendingPathComponent("credentials.lock")
            do { try FileManager.default.removeItem(at: legacy) }
            catch let error as CocoaError where error.code == .fileNoSuchFile { }
        }
    }

    private static func keychainError(_ status: OSStatus) -> ChatError {
        .message("Account storage could not be accessed (Keychain \(status)). Unlock this Mac and check signing entitlements.")
    }
}
