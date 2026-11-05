import SwiftUI
import AppKit

@main
struct SafariChatApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup("Safari Chat") {
            SetupView(model: model)
                .onOpenURL { url in
                    guard url.scheme == "safarichat", url.host == "connect" else { return }
                    NSApp.activate(ignoringOtherApps: true)
                    model.refresh()
                }
        }.windowStyle(.hiddenTitleBar).windowResizability(.contentSize)
    }
}

struct SetupView: View {
    @ObservedObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    private let green = Color(red: 0.25, green: 0.43, blue: 0.33)

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Image(systemName: "sparkle").font(.system(size: 32, weight: .light)).foregroundStyle(green)
                    .frame(width: 58, height: 58).background(green.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                Spacer()
                Text("SAFARI CHAT").font(.system(size: 10, weight: .semibold, design: .rounded)).tracking(2).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 9) {
                Text("A little help.\nRight where you browse.").font(.system(size: 32, weight: .medium)).tracking(-1)
                Text("Connect your account, enable the extension, and make yourself at home in Safari.")
                    .font(.system(size: 13)).foregroundStyle(.secondary).lineSpacing(4)
            }
            VStack(alignment: .leading, spacing: 13) {
                Label("1  Connect your account", systemImage: "person.crop.circle").font(.system(size: 14, weight: .semibold))
                if !model.accounts.isEmpty {
                    ForEach(model.accounts) { account in
                        HStack {
                            Button { model.select(account) } label: {
                                HStack { Image(systemName: model.activeID == account.id ? "checkmark.circle.fill" : "circle"); Text(account.label).lineLimit(1); Spacer() }
                            }.buttonStyle(.plain).disabled(model.busy)
                            if !account.isAPIKey { Button("Reconnect") { model.signIn(account: account) }.controlSize(.small).disabled(model.busy) }
                        }.font(.system(size: 12))
                    }
                }
                HStack {
                    Button(model.accounts.isEmpty ? "Continue with ChatGPT" : "Add ChatGPT account") { model.signIn() }
                        .buttonStyle(.borderedProminent).tint(green).disabled(model.busy)
                    if model.busy { ProgressView().controlSize(.small); Button("Cancel") { model.cancel() }.buttonStyle(.plain) }
                    else if model.activeID != nil { Button("Sign out") { model.signOut() }.buttonStyle(.plain).foregroundStyle(.secondary) }
                }
                Text("Sign in securely in your browser. Eligible accounts can authorize ChatGPT plan usage. Your existing ChatGPT chats stay in ChatGPT.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineSpacing(3)
                DisclosureGroup("Or use an OpenAI API key", isExpanded: $model.showAPIKey) {
                    HStack {
                        SecureField("sk-…", text: $model.apiKey).textFieldStyle(.roundedBorder)
                        Button("Connect") { model.connectAPIKey(model.apiKey); model.apiKey = "" }.disabled(model.busy || model.apiKey.isEmpty)
                    }.padding(.top, 6)
                    Text("Stored in macOS Keychain. API billing is separate.").font(.system(size: 10)).foregroundStyle(.secondary)
                }.font(.system(size: 11)).foregroundStyle(.secondary)
            }.padding(18).background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 14))
            VStack(alignment: .leading, spacing: 12) {
                Label("2  Enable in Safari", systemImage: model.extensionEnabled ? "checkmark.circle.fill" : "safari").font(.system(size: 14, weight: .semibold))
                Text(model.extensionEnabled ? "You're ready. Click Safari Chat in the Safari toolbar on any website." : "Open Safari settings, turn on Safari Chat, then click its toolbar button on a website.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).lineSpacing(3)
                Button("Open Safari Settings") { model.openSafariSettings() }.buttonStyle(.bordered)
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 14))
            if !model.message.isEmpty { Text(model.message).font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
            Button("Erase native data and quit…") { model.eraseNativeDataAndQuit() }
                .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            HStack {
                Text("Independent companion. Not affiliated with OpenAI.").font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer()
                Link("Manage ChatGPT access ↗", destination: URL(string: "https://chatgpt.com/#settings")!).font(.system(size: 10)).foregroundStyle(green)
            }
        }.padding(32).frame(width: 560, height: model.showAPIKey ? 800 : 740)
            .background(Color(nsColor: .windowBackgroundColor))
            .onChange(of: phase) { _, newPhase in if newPhase == .active { model.refresh() } }
    }
}
