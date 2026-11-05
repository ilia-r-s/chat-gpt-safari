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
        Task {
            do {
                let result: [String: Any]
                switch type {
                case "app.open":
                    try await CompanionApp.open(); result = ["ok": true]
                case "auth.status":
                    let account = try CredentialStore.read().active
                    result = ["ok": true, "connected": account?.accessToken != nil,
                              "canInfer": account?.canInfer ?? false, "account": account?.id ?? "local", "label": account?.label ?? "Connect account"]
                case "auth.credential":
                    let account = try await AuthService.shared.credential()
                    guard let token = account.accessToken else { throw ChatError.message("Sign in in the companion app first.") }
                    result = ["ok": true, "token": token, "account": account.id]
                case "auth.signout":
                    try CredentialStore.signOut(); result = ["ok": true]
                case "data.erase":
                    try await AuthService.shared.eraseLocalData(); result = ["ok": true]
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
