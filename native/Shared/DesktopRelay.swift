import Foundation
import CoreFoundation

enum DesktopApproval {
    static func accepts(_ response: [String: Any]?) -> Bool {
        guard response?["action"] as? String == "accept", let content = response?["content"] as? [String: Any],
              let flag = content["approve"] as? NSNumber, CFGetTypeID(flag) == CFBooleanGetTypeID() else { return false }
        return flag.boolValue
    }
}

struct DesktopLease: Codable, Equatable {
    var id: String
    var token: String
    var port: UInt16
    var expires: Date
    var profileID: String
}

/// Ephemeral local routing credentials share the existing app-specific Keychain vault.
enum DesktopRelay {
    static func profileIdentifier(_ value: Any?) throws -> String {
        guard let value else { return "default" }
        if let id = value as? UUID { return id.uuidString.lowercased() }
        if let string = value as? String, let id = UUID(uuidString: string) { return id.uuidString.lowercased() }
        throw ChatError.message("Safari supplied an unrecognized profile identifier.")
    }

    static func lease(_ id: String, vault: Vault, now: Date = Date()) throws -> DesktopLease {
        guard UUID(uuidString: id) != nil,
              let lease = vault.desktopBridges?.first(where: { $0.id == id }), lease.expires > now,
              lease.port > 0, lease.token.count == 64 else {
            throw ChatError.message("The desktop connection expired or was removed. Reconnect the Safari Chat plugin.")
        }
        return lease
    }

    static func setEnabled(_ enabled: Bool, profileID: String) throws {
        try CredentialStore.update { vault in
            if enabled { vault.desktopProfileID = profileID }
            else if vault.desktopProfileID == profileID { vault.desktopProfileID = nil }
        }
    }

    static func verify(_ id: String, profileID: String) throws -> [String: Any] {
        let vault = try CredentialStore.read()
        _ = try authorizedLease(id, vault: vault, profileID: profileID)
        return ["ok": true, "account": vault.activeID ?? "local", "hostID": vault.hostID]
    }

    static func authorizedLease(_ id: String, vault: Vault, profileID: String, requireEnabled: Bool = true) throws -> DesktopLease {
        let connection = try lease(id, vault: vault)
        guard connection.profileID == profileID, !requireEnabled || vault.desktopProfileID == profileID else { throw ChatError.message("Desktop control belongs to a different Safari profile or was disabled.") }
        return connection
    }

    static func reply(_ payload: [String: Any], profileID: String) async throws {
        guard let id = payload["sessionId"] as? String,
              let requestID = payload["requestId"] as? String, UUID(uuidString: requestID) != nil,
              let type = payload["type"] as? String, ["approval", "result"].contains(type) else {
            throw ChatError.message("Invalid desktop response.")
        }
        let connection = try authorizedLease(id, vault: CredentialStore.read(), profileID: profileID, requireEnabled: false)
        let body = try JSONSerialization.data(withJSONObject: payload)
        guard body.count <= 250000 else { throw ChatError.message("The desktop response exceeded its size limit.") }
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(connection.port)/reply")!)
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 10
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await SecureHTTP.session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ChatError.message("The desktop client did not accept the response.") }
    }
}
