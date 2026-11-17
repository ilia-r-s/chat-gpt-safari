import AppKit
import SwiftUI

@MainActor private final class PreviewAppearance: ObservableObject { @Published var value: AppAppearance = .light }
private struct ChangingAppearancePreview: View {
    @ObservedObject var appearance: PreviewAppearance
    var body: some View {
        SetupContent(appIcon: NSImage(contentsOfFile: "native/App/SafariChatIcon.icns")!, accounts: [], busy: false, message: "", extensionEnabled: false,
                     apiKey: .constant(""), showAPIKey: .constant(false), appearance: $appearance.value) { _ in }
    }
}

/// Render the production setup view with inert fixture data. No AppModel, Keychain,
/// Safari messaging, sign-in, network requests, or app preferences are initialized.
@main @MainActor
enum AppPreview {
    static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let output = URL(fileURLWithPath: "build/screenshots", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let saved = SetupAccount(id: "fixture", title: "alex.with.a.long.account.name@example.com",
                                 detail: "ChatGPT plan usage · 123456", isSelected: true, isAPIKey: false)
        let variants: [(String, AppAppearance, [SetupAccount], Bool, String, Bool, NSSize)] = [
            ("app-light", .light, [], false, "", false, NSSize(width: 600, height: 820)),
            ("app-dark", .dark, [], false, "", false, NSSize(width: 600, height: 820)),
            ("app-account", .light, [saved], false, "Account saved on this Mac.", false, NSSize(width: 600, height: 1000)),
            ("app-compact", .dark, [saved], true, "Continue in your browser.", false, NSSize(width: 520, height: 560)),
            ("app-api-key", .light, [], false, "Could not connect. Check your network and try again.", true, NSSize(width: 600, height: 1000)),
        ]
        for (name, appearance, accounts, busy, message, showKey, size) in variants {
            let content = SetupContent(appIcon: NSImage(contentsOfFile: "native/App/SafariChatIcon.icns")!, accounts: accounts, busy: busy, message: message, extensionEnabled: !accounts.isEmpty,
                                       apiKey: .constant(""), showAPIKey: .constant(showKey), appearance: .constant(appearance)) { _ in }
                .environment(\.colorScheme, appearance.colorScheme!)
            let view = NSHostingView(rootView: content)
            let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -10000, y: -10000), size: size),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: appearance == .dark ? .darkAqua : .aqua)
            window.contentView = view
            window.orderFront(nil)
            view.frame = NSRect(origin: .zero, size: size)
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.15))
            view.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { fatalError("No bitmap for \(name)") }
            view.cacheDisplay(in: view.bounds, to: bitmap)
            guard let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("No PNG for \(name)") }
            try png.write(to: output.appendingPathComponent(name + ".png"))
            print("Rendered \(name): \(Int(view.bounds.width)) × \(Int(view.bounds.height))")
            window.close()
        }
        // Use the actual window/environment path, not the fixed color-scheme
        // overrides used for screenshots. No user appearance preference is saved.
        let appearance = PreviewAppearance()
        let view = NSHostingView(rootView: ChangingAppearancePreview(appearance: appearance))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 600, height: 820), styleMask: [.borderless], backing: .buffered, defer: false)
        let systemIsDark = window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        window.isReleasedWhenClosed = false; window.contentView = view; window.orderFront(nil)
        func verify(dark: Bool) {
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.2)); view.layoutSubtreeIfNeeded(); window.displayIfNeeded()
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: bitmap)
            let color = bitmap.colorAt(x: 5, y: 250)!.usingColorSpace(.deviceRGB)!
            precondition((color.redComponent < 0.5) == dark, "Native appearance did not immediately become \(dark ? "dark" : "light") after selecting \(appearance.value.rawValue)")
        }
        for choice in [AppAppearance.light, .dark, .system, .dark, .light, .system] {
            appearance.value = choice; verify(dark: choice == .system ? systemIsDark : choice == .dark)
        }
        window.close()
        print("Native appearance switching passed: Light/Dark/System, including clearing the window override.")
    }
}
