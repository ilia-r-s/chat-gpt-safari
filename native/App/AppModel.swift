import AppKit
import Foundation
import SafariServices
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var accounts: [Account] = []
    @Published var activeID: String?
    private var generation = "local"
    @Published var busy = false
    @Published var message = ""
    @Published var extensionEnabled = false
    @Published var apiKey = ""
    @Published var showAPIKey = false
    private var signInTask: Task<Void, Never>?
    private var listener: LoopbackListener?
    private var preparingRemoval = false

    init() { refresh() }

    func refresh() {
        guard !preparingRemoval else { return }
        do { let vault = try CredentialStore.read(); accounts = vault.accounts; activeID = vault.activeID; generation = vault.generation }
        catch { message = error.localizedDescription }
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: Configuration.extensionID) { [weak self] state, _ in
            Task { @MainActor in self?.extensionEnabled = state?.isEnabled ?? false }
        }
    }

    func signIn(account: Account? = nil) {
        guard !busy, !preparingRemoval else { return }
        busy = true; message = "Continue in your browser."
        signInTask = Task {
            let listener = LoopbackListener(); self.listener = listener
            defer { listener.cancel(); self.listener = nil; busy = false }
            do {
                // Persist host identity before first authorization, even if sign-in is cancelled.
                let vault = try CredentialStore.update { _ in }
                let startGeneration = vault.generation
                let port = try await listener.start()
                let attempt = try OAuthAttempt(port: port, hostID: vault.hostID, account: account)
                let callback = try await listener.wait(state: attempt.state) {
                    if !NSWorkspace.shared.open(attempt.authorizationURL()) { listener.cancel(message: "Could not open the system browser.") }
                }
                try Task.checkCancellation()
                message = "Verifying your account…"
                let connected = try await OAuthClient.finish(attempt, callback: callback)
                try Task.checkCancellation()
                try CredentialStore.update { vault in
                    guard vault.hostID == attempt.hostID else { throw ChatError.message("Local data was erased during sign-in. Start sign-in again if you want to reconnect.") }
                    if let index = vault.accounts.firstIndex(where: { $0.id == connected.id }) { vault.accounts[index] = connected }
                    else { vault.accounts.append(connected) }
                    guard vault.generation == startGeneration else { throw ChatError.message("The selected account changed during sign-in. Please try again.") }
                    vault.activate(connected.id)
                }
                message = connected.canInfer ? "Connected. Return to Safari and open Safari Chat." : "Signed in. ChatGPT plan usage was not granted; enable it by signing in again, or use an API key."
                refresh()
                AccountEvents.notify(Configuration.extensionID)
            } catch { message = error.localizedDescription; AccountEvents.notify(Configuration.extensionID, error: message) }
        }
    }

    func cancel() { signInTask?.cancel(); listener?.cancel() }

    func select(_ account: Account) {
        guard !busy, !preparingRemoval else { return }
        if account.accessToken == nil { if !account.isAPIKey { signIn(account: account) }; return }
        if activeID == account.id { return }
        do {
            try CredentialStore.update { vault in
                guard vault.accounts.contains(where: { $0.id == account.id && $0.accessToken != nil }) else { throw ChatError.message("This account was removed. Sign in again to reconnect.") }
                vault.activate(account.id)
            }
            refresh(); message = "Account selected."
            AccountEvents.notify(Configuration.extensionID)
        }
        catch { message = error.localizedDescription }
    }

    func signOut() {
        guard !busy, !preparingRemoval else { return }
        let expected = generation
        busy = true; message = "Signing out…"
        signInTask = Task {
            defer { busy = false; refresh() }
            do { message = try await AuthService.shared.signOut(expected: expected, extensionID: Configuration.extensionID) }
            catch { message = error.localizedDescription }
        }
    }

    func connectAPIKey(_ input: String, name: String, replacing id: String?) {
        let key = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.hasPrefix("sk-"), key.count >= 20, key.count < 512, !key.contains(where: \.isWhitespace) else { message = "Enter a valid OpenAI API key."; return }
        guard !busy, !preparingRemoval else { return }
        busy = true; message = "Checking API access…"
        signInTask = Task {
            defer { busy = false }
            do {
                let original = try CredentialStore.update { _ in }
                var request = URLRequest(url: URL(string: Configuration.resource + "/models")!)
                request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                let (_, response) = try await SecureHTTP.session.data(for: request)
                try Task.checkCancellation()
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ChatError.message("This API key could not access the model catalog. Check its permissions and try again.") }
                try CredentialStore.update { vault in
                    guard vault.hostID == original.hostID else { throw ChatError.message("Local data was erased while connecting. Connect again if you want to keep using Safari Chat.") }
                    guard vault.generation == original.generation else { throw ChatError.message("The selected account changed while connecting. Please try again.") }
                    try vault.connectKey(key, name: name, replacing: id)
                }
                refresh(); message = id == nil ? "API key connected. This connection has its own chat history." : "Key replaced. This connection’s chat history is available."
                AccountEvents.notify(Configuration.extensionID)
            } catch { message = error.localizedDescription }
        }
    }

    func openSafariSettings() {
        SFSafariApplication.showPreferencesForExtension(withIdentifier: Configuration.extensionID) { [weak self] error in
            Task { @MainActor in
                if error != nil { self?.message = "Open Safari → Settings → Extensions and enable Safari Chat." }
            }
        }
    }

    func eraseNativeDataAndQuit() {
        guard !preparingRemoval else { return }
        let alert = NSAlert()
        alert.messageText = "Erase Safari Chat's native data and quit?"
        alert.informativeText = "First use Erase local data in the extension's settings in each Safari profile you use. This step deletes all saved Safari Chat accounts and this app's caches and preferences. Then remove Safari Chat in Safari Settings and move the app to Trash. System records, backups and exported chats are outside this cleanup."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Erase and Quit")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        preparingRemoval = true
        cancel()
        let pending = signInTask
        busy = true
        Task {
            await pending?.value
            do {
                for window in NSApp.windows { window.isRestorable = false }
                try await AuthService.shared.eraseLocalData()
                AccountEvents.notify(Configuration.extensionID)
                accounts = []; activeID = nil; apiKey = ""
                NSApp.terminate(nil)
            } catch {
                preparingRemoval = false; busy = false
                accounts = []; activeID = nil; apiKey = ""
                message = "Cleanup did not finish: \(error.localizedDescription)"
            }
        }
    }
}
