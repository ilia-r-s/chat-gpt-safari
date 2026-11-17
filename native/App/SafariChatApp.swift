import SwiftUI
import AppKit

@main
@MainActor
struct SafariChatEntry {
    static func main() {
        if CommandLine.arguments.contains("--mcp") { DesktopMCP.run() }
        else { SafariChatApp.main() }
    }
}

struct SafariChatApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup("Safari Chat") {
            SetupView(model: model)
                .onOpenURL { url in
                    if CompanionApp.isSignInURL(url) { model.signIn(); return }
                    guard url.scheme == "safarichat", url.host == "connect" else { return }
                    NSApp.activate(ignoringOtherApps: true)
                    model.refresh()
                }
        }.windowStyle(.hiddenTitleBar).windowResizability(.contentMinSize)
            .defaultSize(width: 600, height: 820)
    }
}

struct SetupView: View {
    @ObservedObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    @AppStorage("appearance") private var appearance: AppAppearance = .system

    var body: some View {
        SetupContent(appIcon: NSImage(named: "SafariChatIcon") ?? NSImage(), accounts: model.accounts.map { account in
            SetupAccount(id: account.id, title: account.isAPIKey ? account.label : account.email.isEmpty ? account.name : account.email,
                         detail: account.accessToken == nil ? "Signed out" : account.isAPIKey ? "API billing" : "\(account.canInfer ? "ChatGPT plan usage" : "Plan usage not enabled") · \(account.id.suffix(6))",
                         isSelected: model.activeID == account.id, isAPIKey: account.isAPIKey, needsKey: account.isAPIKey && account.accessToken == nil)
        }, busy: model.busy, message: model.message, extensionEnabled: model.extensionEnabled,
                     apiKey: $model.apiKey, showAPIKey: $model.showAPIKey, appearance: $appearance) { action in
            switch action {
            case .signIn: model.signIn()
            case .select(let id): if let account = model.accounts.first(where: { $0.id == id }) { model.select(account) }
            case .reconnect(let id): if let account = model.accounts.first(where: { $0.id == id }) { model.signIn(account: account) }
            case .signOut: model.signOut()
            case .cancel: model.cancel()
            case .connectAPIKey(let name, let id): model.connectAPIKey(model.apiKey, name: name, replacing: id); model.apiKey = ""
            case .safariSettings: model.openSafariSettings()
            case .eraseData: model.eraseNativeDataAndQuit()
            }
        }.onChange(of: phase) { _, newPhase in if newPhase == .active { model.refresh() } }
    }
}
