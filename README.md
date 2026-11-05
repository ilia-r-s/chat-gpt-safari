# Safari Chat

An independent Safari companion inspired by [OpenAI's ChatGPT Chrome extension](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg). Built with Swift, Safari Web Extensions, and dependency-free JavaScript. **Development preview; not affiliated with OpenAI.**

## What is implemented

- Side chat on websites, with a full-tab fallback on protected pages, light/dark themes, streaming, cancellation, and escaped Markdown.
- Explicit page, selected-text, other accessible tab, and text-file attachments. Right-click **Ask Safari Chat** or use **Command–Shift–.**
- Browser tools for reading, clicking, filling, navigation, opening/closing tabs, and listing accessible tabs. Enable them in settings; writes require approval and stale pages invalidate actions.
- **Continue with ChatGPT** using OpenAI's documented open-source OAuth flow: loopback callback, PKCE, state/nonce verification, RS256/ES256 ID-token verification, account selection, refresh, and Keychain storage. API keys are an alternative, stored in the native app.
- Local account-separated chat history, search, deletion, and Markdown export.
- A removal preparation flow clears browser storage and the app's Keychain record, stops active tasks, and blocks late writes. Native cleanup stays within each process's own sandbox; no custom lock files or global data directories.
- Explicit context budgets, deduplication, bounded tool loops, a cached model catalog, and actual token usage display.

**This is not full Chrome-extension parity.** Existing ChatGPT chats, plugins, memories, desktop integration, voice, images/PDFs, downloads, and cross-site browser automation require additional work or capabilities not exposed by the public flow. See [feature coverage](docs/parity.md).

## Build and install

Target: macOS 14+ and Safari 17+. No runtime dependencies are required by the finished app. Xcode is needed only to build/sign from source; Node 22+ is used only for JavaScript tests. Python's standard library generates the project/background bundle. No third-party packages are required for the build.

```sh
./scripts/build.sh        # Debug app, unsigned
./scripts/package.sh      # Universal Release app + unsigned ZIP
./scripts/check.sh        # JavaScript, native tests, and project checks
```

Artifacts:

- `build/DerivedData/Build/Products/Release/Safari Chat.app`
- `build/Safari-Chat-unsigned.zip` and its SHA-256 checksum

**The unsigned archive is a development artifact, not a one-click installer.** macOS/Safari may refuse to run it, and native shared credentials require valid signing. The current build was intentionally prepared unsigned. [Unsigned-build instructions](docs/INSTALL-UNSIGNED.txt) explain what remains.

For an interface-only preview, Safari versions with **Settings → Developer → Add Temporary Extension…** can load the repo's `extension/` folder directly. Enable **Show features for web developers** in Advanced settings first. Temporary extensions cannot use native companion messaging, so **Connect account** shows setup guidance; real sign-in and chat require the packaged app below. Safari removes the temporary extension on quit or after 24 hours. [Apple's temporary-install instructions](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension).

To test the full extension, open `SafariChat.xcodeproj`, set the same Apple development team for both targets, and configure their shared App Groups/Keychain Sharing capability. The `SAFARI_CHAT_BUNDLE_ID` and `SAFARI_CHAT_GROUP_ID` build settings allow unique identifiers without editing the source. Run the **Safari Chat** scheme, enable it under **Safari → Settings → Extensions**, and connect an account in the companion app. Safari's development setting **Allow Unsigned Extensions** may be required; it does not replace signing entitlements for Keychain/App Groups.

An older preview may open `safarichat://connect` and show “address is invalid” when the companion is not registered. Reload the temporary extension after updating, or rebuild the packaged app. The current button requests a native app launch and reports failures inside the panel without opening a Safari tab.

For a public release, sign and notarize the app, or distribute through the Mac App Store. End users then install one app and enable its extension—no additional language runtime, package manager, server, or ChatGPT desktop installation.

## Remove data and uninstall

Use **Settings → Erase local data…** in each Safari profile, then **Erase native data and quit…** in the companion app before uninstalling through Safari and deleting the app. Cleanup errors are reported and can be retried. Chats/settings remain browser-contained; credentials use Keychain. Ordinary sign-out does not erase history or registration metadata.

The app cannot guarantee erasing OS/browser records, backups, shared sign-in cookies, remote service records, or user exports. [Data locations and exact removal scope](docs/data-lifecycle.md) explain the practical limits. No actual installed user data is removed by the development tests.

## Development

Read [AGENTS.md](AGENTS.md) for a short source map and token-efficient development rules. [Architecture](docs/architecture.md) explains the security and performance boundaries. [Validation](docs/validation.md) records what has and has not been verified.

All build outputs and caches stay in `build/`, `.build/`, and `.cache/`. No global packages are installed. If `node` is not on PATH, set `SAFARI_CHAT_NODE` to an existing runtime. The test launcher can also use the Node runtime already included with ChatGPT.app; this is a development convenience, never a shipped dependency.

The background source uses small ES modules. Apple's converter does not accept the background module flags used by some other browsers, so `python3 scripts/bundle-background.py` emits a synchronous classic background bundle. It has no build dependencies. Do not edit the generated file. Xcode can open the committed project directly; regenerate the bundle after background/core changes. `python3 scripts/generate-project.py` recreates the deterministic Xcode project when source files are added; it resets project-local signing edits, so commit/customize the generator if needed.

Optional UI smoke tests use an existing Playwright installation and an isolated Chrome profile:

```sh
SAFARI_CHAT_PLAYWRIGHT=/absolute/path/to/playwright/index.mjs \
SAFARI_CHAT_CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
./scripts/node.sh tests/ui-smoke.mjs
```

Screenshots go to `build/screenshots/`. These tests exercise the UI and DOM helpers with simulated account/model responses; they are not a live Safari/OAuth test.
