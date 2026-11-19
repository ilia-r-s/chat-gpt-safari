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
    var canChat = true
}

enum SetupAction {
    case signIn, select(String), reconnect(String), signOut, cancel, connectAPIKey(String, replacing: String?), safariSettings, eraseData
}

struct SetupContent: View {
    let appIcon: NSImage
    let accounts: [SetupAccount]
    let busy: Bool
    let message: String
    let extensionEnabled: Bool?
    @Binding var apiKey: String
    @Binding var showAPIKey: Bool
    @Binding var appearance: AppAppearance
    var keyEntryRequest = 0
    let perform: (SetupAction) -> Void
    @FocusState private var keyFocused: Bool
    @State private var keyName = ""
    @State private var replacing: String?
    @Environment(\.colorScheme) private var colorScheme
    private var palette: SetupPalette { SetupPalette(dark: colorScheme == .dark) }
    private var hasSelection: Bool { accounts.contains(where: \.isSelected) }

    private var hasChatAccount: Bool { accounts.contains { $0.isSelected && $0.canChat } }
    private var setupTitle: String {
        if showAPIKey { return replacing == nil ? "Connect an API key" : "Replace an API key" }
        if !hasChatAccount { return hasSelection ? "Enable chat for your account" : "Connect your account" }
        return extensionEnabled == true ? "Open side chat in Safari" : "Enable Safari Chat in Safari"
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(setupTitle).font(.system(size: 27, weight: .semibold)).tracking(-0.7)
                    if !message.isEmpty {
                        Label { Text(message).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                            icon: { Image(systemName: "info.circle") }
                            .font(.system(size: 12)).foregroundStyle(palette.muted)
                    }
                    if hasChatAccount && !showAPIKey {
                        safariCard
                        accountCard
                    } else {
                        accountCard
                        safariCard
                    }
                    localData
                }.frame(maxWidth: 620, alignment: .leading).padding(.horizontal, 28).padding(.vertical, 20)
                    .frame(maxWidth: .infinity)
            }
            Divider()
            footer
        }.foregroundStyle(palette.text).tint(palette.text).background(palette.surface)
            .background(WindowAppearance(appearance: appearance))
            .frame(minWidth: 520, minHeight: 560)
            .onChange(of: showAPIKey) { _, expanded in
                if !expanded && apiKey.isEmpty { replacing = nil; keyName = "" }
            }
            .onChange(of: keyEntryRequest) { _, _ in
                if replacing != nil { editKey(nil) }
                keyFocused = true
            }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(nsImage: appIcon).resizable().interpolation(.high)
                .frame(width: 26, height: 26)
                .accessibilityHidden(true)
            Text("Safari Chat").font(.system(size: 15, weight: .semibold))
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
        }.padding(.horizontal, 28).padding(.top, 22).padding(.bottom, 10)
            .background(palette.surface)
    }

    private var accountCard: some View {
        section("Accounts", symbol: "person.crop.circle") {
            if showAPIKey { keyForm }
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
                                Button(account.needsKey ? "Reconnect" : "Replace key") { editKey(account.id) }.buttonStyle(SetupButtonStyle()).disabled(busy)
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
            Text("Sign in through your browser to use an eligible ChatGPT plan. Each connection has its own local chats.")
                .font(.system(size: 12)).foregroundStyle(palette.muted).lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            if !showAPIKey { keyForm }

        }
    }

    private var keyForm: some View {
        DisclosureGroup("Use an OpenAI API key", isExpanded: $showAPIKey) {
            VStack(alignment: .leading, spacing: 9) {
                if let account = accounts.first(where: { $0.id == replacing }) {
                    Text("Replace the key for \(account.title) to keep its chats and drafts.")
                    Button("Add a separate connection") { editKey(nil) }.buttonStyle(.link).disabled(busy)
                } else {
                    TextField("Connection name (optional)", text: $keyName).textFieldStyle(.roundedBorder).disabled(busy)
                }
                HStack(spacing: 10) {
                    SecureField("OpenAI API key", text: $apiKey).textFieldStyle(.plain).focused($keyFocused)
                        .onAppear { keyFocused = true }
                        .padding(10).background(palette.soft, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.line))
                        .disabled(busy).onSubmit { if !busy && !apiKey.isEmpty { submitKey() } }
                    Button(replacing == nil ? "Connect" : "Replace key") { submitKey() }
                        .buttonStyle(SetupButtonStyle()).disabled(busy || apiKey.isEmpty)
                }
                Text("Keys are stored in macOS Keychain. Requests use your OpenAI API billing account.")
                    .font(.system(size: 11)).foregroundStyle(palette.muted)
            }.padding(.top, 10)
        }.font(.system(size: 12))
    }

    private func editKey(_ id: String?) {
        replacing = id; keyName = ""; apiKey = ""; showAPIKey = true
    }

    private func submitKey() {
        perform(.connectAPIKey(keyName, replacing: replacing))
    }

    private var safariCard: some View {
        section("Safari extension", symbol: "safari") {
            HStack(alignment: .center, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(extensionEnabled.map { $0 ? "Enabled in Safari" : "Extension is off" } ?? "Check extension access")
                        .font(.system(size: 13, weight: .medium))
                    Text(extensionEnabled == true
                         ? "Open a website and click Safari Chat in the toolbar, or press ⌘⇧. to open side chat."
                         : "In Safari Settings, select Extensions and enable Safari Chat.")
                        .font(.system(size: 12)).foregroundStyle(palette.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button(extensionEnabled == true ? "Manage in Safari ↗" : "Open Safari Settings ↗") { perform(.safariSettings) }
                    .buttonStyle(SetupButtonStyle(prominent: hasChatAccount && extensionEnabled != true))
            }
        }
    }

    private var localData: some View {
        DisclosureGroup("Local data") {
            VStack(alignment: .leading, spacing: 9) {
                Text("To remove chats and website rules, open Remove your data in the side chat’s Settings. This app can also erase saved accounts and app preferences.")
                    .font(.system(size: 12)).foregroundStyle(palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Erase native data and quit…") { perform(.eraseData) }
                    .buttonStyle(SetupButtonStyle()).disabled(busy)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
        }.font(.system(size: 13, weight: .medium))
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

    private func section<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            Label(title, systemImage: symbol).font(.system(size: 14, weight: .semibold))
            content()
        }.frame(maxWidth: .infinity, alignment: .leading)
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
            .background(prominent ? palette.text : palette.soft, in: Capsule())
            .overlay(Capsule().strokeBorder(prominent ? .clear : palette.line))
            .opacity(!isEnabled ? 0.4 : configuration.isPressed ? 0.7 : 1)
    }
}

private struct SetupPalette {
    let dark: Bool
    var surface: Color { color(dark ? 0x1b1b1b : 0xffffff) }
    var text: Color { color(dark ? 0xececec : 0x202020) }
    var muted: Color { color(dark ? 0xb4b4b4 : 0x686868) }
    var soft: Color { color(dark ? 0x3a3a3a : 0xf5f5f5) }
    var line: Color { color(dark ? 0x424242 : 0xe5e5e5) }
    private func color(_ rgb: Int) -> Color {
        Color(.sRGB, red: Double(rgb >> 16 & 255) / 255, green: Double(rgb >> 8 & 255) / 255, blue: Double(rgb & 255) / 255, opacity: 1)
    }
}
