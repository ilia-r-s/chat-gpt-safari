import SafariServices
import Foundation

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
              let type = message["type"] as? String else {
            NativeReply(context).send(["ok": false, "error": "Invalid native request."]); return
        }
        let reply = NativeReply(context)
        let profileID: String
        do { profileID = try DesktopRelay.profileIdentifier(item.userInfo?[SFExtensionProfileKey]) }
        catch { reply.send(["ok": false, "error": error.localizedDescription]); return }
        let sessionID = message["sessionId"] as? String ?? ""
        let desktopEnabled = message["enabled"] as? Bool
        let generation = message["generation"] as? String ?? ""
        let extensionID = Bundle(for: SafariWebExtensionHandler.self).bundleIdentifier ?? Configuration.extensionID
        let desktopPayload = (message["payload"] as? [String: Any]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
        Task {
            do {
                let result: [String: Any]
                switch type {
                case "app.open":
                    try await CompanionApp.open(extensionBundle: Bundle(for: SafariWebExtensionHandler.self)); result = ["ok": true]
                case "auth.signin", "auth.apikey":
                    let action: CompanionApp.Action = type == "auth.signin" ? .signIn : .apiKey
                    try await CompanionApp.open(extensionBundle: Bundle(for: SafariWebExtensionHandler.self), action: action)
                    result = ["ok": true]
                case "desktop.verify":
                    result = try DesktopRelay.verify(sessionID, profileID: profileID)
                case "desktop.enable":
                    guard let enabled = desktopEnabled else { throw ChatError.message("Invalid desktop setting.") }
                    try DesktopRelay.setEnabled(enabled, profileID: profileID); result = ["ok": true]
                case "desktop.reply":
                    guard let desktopPayload, desktopPayload.count <= 250000,
                          let payload = try JSONSerialization.jsonObject(with: desktopPayload) as? [String: Any] else { throw ChatError.message("Invalid desktop response.") }
                    try await DesktopRelay.reply(payload, profileID: profileID); result = ["ok": true]
                case "auth.status":
                    let vault = try CredentialStore.read()
                    let account = vault.active
                    result = ["ok": true, "connected": account?.accessToken != nil,
                              "canInfer": account?.canInfer ?? false, "account": account?.id ?? "local", "generation": vault.generation, "label": account?.label ?? "Connect account"]
                case "auth.credential":
                    let account = try await AuthService.shared.credential(generation: generation)
                    let current = try CredentialStore.read()
                    guard current.generation == generation, current.active?.id == account.id,
                          current.active?.accessToken == account.accessToken else { throw ChatError.message("The selected account changed.") }
                    guard let token = account.accessToken else { throw ChatError.message("Sign in in the companion app first.") }
                    result = ["ok": true, "token": token, "account": account.id, "generation": generation]
                case "auth.signout":
                    let message = try await AuthService.shared.signOut(expected: generation, extensionID: extensionID)
                    result = ["ok": true, "message": message]
                case "data.erase":
                    try await AuthService.shared.eraseLocalData(); AccountEvents.notify(extensionID); result = ["ok": true]
                default: throw ChatError.message("Unsupported native request.")
                }
                reply.send(result)
            } catch { reply.send(["ok": false, "error": error.localizedDescription]) }
        }
    }

}

// Ownership is transferred to exactly one task. No context is accessed concurrently.
private final class NativeReply: @unchecked Sendable {
    private let context: NSExtensionContext
    init(_ context: NSExtensionContext) { self.context = context }
    func send(_ message: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: message]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
