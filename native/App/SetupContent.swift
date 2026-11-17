import SwiftUI

enum AppAppearance: String, CaseIterable {
    case system, light, dark
    var title: String { rawValue.capitalized }
    var colorScheme: ColorScheme? {
        switch self { case .system: nil; case .light: .light; case .dark: .dark }
    }
    var nativeAppearance: NSAppearance? {
        switch self { case .system: nil; case .light: NSAppearance(named: .aqua); case .dark: NSAppearance(named: .darkAqua) }
    }
}

// Explicitly clear the window override for System. SwiftUI's preferredColorScheme
// can retain the previous appearance when its value changes back to nil on macOS.
private struct WindowAppearance: NSViewRepresentable {
    let appearance: AppAppearance
    func makeNSView(context: Context) -> AppearanceView { AppearanceView() }
    func updateNSView(_ view: AppearanceView, context: Context) { view.selection = appearance }
    final class AppearanceView: NSView {
        var selection: AppAppearance = .system { didSet { window?.appearance = selection.nativeAppearance } }
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); window?.appearance = selection.nativeAppearance }
    }
}

// Presentation data contains no credentials; previews need no account or Safari access.
struct SetupAccount: Identifiable {
    let id: String
    let title: String
    let detail: String
    let isSelected: Bool
    let isAPIKey: Bool
    var needsKey = false
}

enum SetupAction {
    case signIn, select(String), reconnect(String), signOut, cancel, connectAPIKey(String, replacing: String?), safariSettings, eraseData
}

struct SetupContent: View {
    let appIcon: NSImage
    let accounts: [SetupAccount]
    let busy: Bool
    let message: String
    let extensionEnabled: Bool
    @Binding var apiKey: String
    @Binding var showAPIKey: Bool
    @Binding var appearance: AppAppearance
    let perform: (SetupAction) -> Void
    @State private var keyName = ""
    @State private var replacing: String?
    @Environment(\.colorScheme) private var colorScheme
    private var palette: SetupPalette { SetupPalette(dark: colorScheme == .dark) }
    private var hasSelection: Bool { accounts.contains(where: \.isSelected) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(palette.line).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(hasSelection ? "Accounts and Safari" : "Set up Safari Chat")
                            .font(.system(size: 27, weight: .semibold)).tracking(-0.6)
                        Text(hasSelection && extensionEnabled ? "Open side chat from the Safari toolbar or press ⌘⇧. on a website." : "Connect an account and enable the extension to chat beside a webpage.")
                            .font(.system(size: 13)).foregroundStyle(palette.muted).lineSpacing(4)
                    }.padding(.vertical, 4)
                    accountCard
                    safariCard
                    localData
                }.padding(28).frame(maxWidth: 680)
                    .frame(maxWidth: .infinity)
            }
            Rectangle().fill(palette.line).frame(height: 1)
            footer
        }.foregroundStyle(palette.text).tint(palette.text).background(palette.background)
            .background(WindowAppearance(appearance: appearance))
            .frame(minWidth: 520, minHeight: 560)
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(nsImage: appIcon).resizable().interpolation(.high)
                .frame(width: 42, height: 42)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text("Safari Chat").font(.system(size: 15, weight: .semibold))
                Text("Account & setup").font(.system(size: 11)).foregroundStyle(palette.muted)
            }
            Spacer()
            Menu {
                Picker("App appearance", selection: $appearance) {
                    ForEach(AppAppearance.allCases, id: \.self) { Text($0.title).tag($0) }
                }
            } label: {
                Label(appearance.title, systemImage: "circle.lefthalf.filled")
                    .font(.system(size: 12))
            }.menuStyle(.borderlessButton).fixedSize()
                .help("Appearance for this app").accessibilityLabel("App appearance: \(appearance.title)")
        }.padding(.horizontal, 28).padding(.top, 22).padding(.bottom, 20)
            .background(palette.surface)
    }

    private var accountCard: some View {
        card("Account", symbol: "person.crop.circle", status: hasSelection ? "Saved on this Mac" : "Sign in") {
            if !message.isEmpty {
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: "info.circle").accessibilityHidden(true)
                    Text(message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }.font(.system(size: 12)).lineSpacing(3).padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(palette.soft, in: RoundedRectangle(cornerRadius: 9))
                    .accessibilityLabel("Status: \(message)")
            }
            if !accounts.isEmpty {
                VStack(spacing: 8) {
                    ForEach(accounts) { account in
                        HStack(spacing: 12) {
                            Button { if account.needsKey { editKey(account.id) } else { perform(.select(account.id)) } } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: account.isSelected ? "checkmark.circle.fill" : "circle")
                                        .font(.system(size: 17))
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(account.title.isEmpty ? "ChatGPT account" : account.title)
                                            .font(.system(size: 12, weight: .medium))
                                        Text(account.detail).font(.system(size: 11)).foregroundStyle(palette.muted)
                                    }.fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(account.isSelected ? palette.soft : palette.surface, in: RoundedRectangle(cornerRadius: 9))
                            }.buttonStyle(.plain).disabled(busy)
                                .accessibilityLabel("\(account.title), \(account.isSelected ? "selected" : "select account")")
                            if account.isAPIKey {
                                Button("Replace key") { editKey(account.id) }.buttonStyle(SetupButtonStyle()).disabled(busy)
                            } else {
                                Button("Reconnect") { perform(.reconnect(account.id)) }
                                    .buttonStyle(SetupButtonStyle()).disabled(busy)
                            }
                        }
                    }
                }
            }
            HStack(spacing: 12) {
                Button(accounts.isEmpty ? "Continue with ChatGPT" : "Add ChatGPT account") { perform(.signIn) }
                    .buttonStyle(SetupButtonStyle(prominent: true)).disabled(busy)
                if busy {
                    ProgressView().controlSize(.small).accessibilityLabel("Connecting")
                    Button("Cancel") { perform(.cancel) }.buttonStyle(SetupButtonStyle())
                } else if hasSelection {
                    Button("Sign out") { perform(.signOut) }.buttonStyle(SetupButtonStyle())
                }
            }
            Text("Sign in through your browser. Eligible accounts can authorize ChatGPT plan usage. Existing ChatGPT chats stay in ChatGPT.")
                .font(.system(size: 12)).foregroundStyle(palette.muted).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            DisclosureGroup("API key connections", isExpanded: $showAPIKey) {
                VStack(alignment: .leading, spacing: 9) {
                    if let account = accounts.first(where: { $0.id == replacing }) {
                        Text("Replace the key for \(account.title) to keep its chats and drafts.")
                        Button("Add a separate connection") { editKey(nil) }.buttonStyle(.link).disabled(busy)
                    } else {
                        TextField("Connection name (optional)", text: $keyName).textFieldStyle(.roundedBorder).disabled(busy)
                    }
                    HStack(spacing: 10) {
                        SecureField("OpenAI API key", text: $apiKey).textFieldStyle(.plain)
                            .padding(10).background(palette.soft, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.line))
                            .disabled(busy).onSubmit { if !busy && !apiKey.isEmpty { submitKey() } }
                        Button(replacing == nil ? "Connect" : "Replace key") { submitKey() }
                            .buttonStyle(SetupButtonStyle()).disabled(busy || apiKey.isEmpty)
                    }
                    Text("New connections keep separate chat histories. Keys are stored in macOS Keychain and use API billing.")
                        .font(.system(size: 11)).foregroundStyle(palette.muted)
                }.padding(.top, 10)
            }.font(.system(size: 12))

        }
    }

    private func editKey(_ id: String?) {
        replacing = id; keyName = ""; apiKey = ""; showAPIKey = true
    }

    private func submitKey() {
        perform(.connectAPIKey(keyName, replacing: replacing))
    }

    private var safariCard: some View {
        card("Safari extension", symbol: "safari", status: extensionEnabled ? "Enabled" : "Set up") {
            Text(extensionEnabled ? "Click Safari Chat in the Safari toolbar on a website to start a conversation." : "Open Safari settings, choose Extensions, and turn on Safari Chat.")
                .font(.system(size: 12)).foregroundStyle(palette.muted).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Button { perform(.safariSettings) } label: {
                HStack(spacing: 10) { Text("Open Safari Settings"); Image(systemName: "arrow.up.right").font(.system(size: 10)) }
            }.buttonStyle(SetupButtonStyle())
            Text("You can quit this app. Safari opens it when sign-in is needed.")
                .font(.system(size: 11)).foregroundStyle(palette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var localData: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Local data").font(.system(size: 12, weight: .semibold))
            Text("For chats and drafts, open the chat panel’s Settings → Erase local data. Remove saved accounts and app preferences here.")
                .font(.system(size: 11)).foregroundStyle(palette.muted).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            Button("Erase native data and quit…") { perform(.eraseData) }
                .buttonStyle(SetupButtonStyle()).disabled(busy)
        }.padding(.horizontal, 4).padding(.top, 4)
    }

    private var footer: some View {
        HStack(spacing: 18) {
            Text("Independent companion.\nNot affiliated with OpenAI.")
                .foregroundStyle(palette.muted).lineSpacing(2)
            Spacer(minLength: 0)
            Link(destination: URL(string: "https://chatgpt.com/#settings")!) {
                Label("Manage ChatGPT access", systemImage: "arrow.up.right")
            }.fixedSize()
        }.font(.system(size: 10)).padding(.horizontal, 28).padding(.vertical, 16)
            .background(palette.surface)
    }

    private func card<Content: View>(_ title: String, symbol: String, status: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(spacing: 9) {
                Image(systemName: symbol).font(.system(size: 18)).accessibilityHidden(true)
                Text(title).font(.system(size: 14, weight: .semibold))
                Spacer(minLength: 8)
                Text(status).font(.system(size: 10, weight: .medium)).foregroundStyle(palette.muted)
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(palette.soft, in: Capsule())
            }
            content()
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(palette.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(palette.line))
    }
}

private struct SetupButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: ButtonStyleConfiguration) -> some View {
        let palette = SetupPalette(dark: colorScheme == .dark)
        configuration.label.font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 13).padding(.vertical, 10)
            .foregroundStyle(prominent ? palette.surface : palette.text)
            .background(prominent ? palette.text : palette.soft, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(prominent ? .clear : palette.line))
            .opacity(!isEnabled ? 0.4 : configuration.isPressed ? 0.7 : 1)
    }
}

private struct SetupPalette {
    let dark: Bool
    var background: Color { color(dark ? 0x212121 : 0xf7f7f7) }
    var surface: Color { color(dark ? 0x303030 : 0xffffff) }
    var text: Color { color(dark ? 0xececec : 0x202020) }
    var muted: Color { color(dark ? 0xb4b4b4 : 0x686868) }
    var soft: Color { color(dark ? 0x3a3a3a : 0xf5f5f5) }
    var line: Color { color(dark ? 0x424242 : 0xe5e5e5) }
    private func color(_ rgb: Int) -> Color {
        Color(.sRGB, red: Double(rgb >> 16 & 255) / 255, green: Double(rgb >> 8 & 255) / 255, blue: Double(rgb & 255) / 255, opacity: 1)
    }
}
