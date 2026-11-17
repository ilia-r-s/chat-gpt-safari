# Safari Chat

An independent Safari companion inspired by [OpenAI's ChatGPT Chrome extension](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg). Built with Swift, Safari Web Extensions, and dependency-free JavaScript. **Development preview; not affiliated with OpenAI.**

## Using side chat

Open **Safari Chat** from the Safari toolbar or press **Command–Shift–Period** on a website. The dock makes room on the right. Opening it leaves the page private until you choose what to share. The header gives you recent chats, a new chat, a standalone chat tab and Settings.

- **Share a page or passage.** Right-click **Ask Safari Chat** to attach the selected text or current page, then review it in the composer. You can also choose **Summarize this page** or **Explain selected text**. A page excerpt can include timestamped captions when a visible video exposes a displayed caption track.
- **Mention tabs and add files.** Type `@` and choose a Safari tab by title or address. Arrow keys move through suggestions, Enter selects and Escape dismisses. **+ → Add browser tabs** supports multiple selections. Select, drop or paste UTF-8 files. A message can carry six sources. File formatting and independent same-name attachments are preserved within the context limit.
- **Work with a page.** Ask for a page read, tab list, click, field edit, dropdown selection, checkbox change, scroll, navigation, or a tab to be opened or closed. **Ask before acting** explains the approvals. Each proposed change names its target and effect. A standalone chat tab is useful for multi-page work because navigation can interrupt a docked response. After ordinary navigation the dock reopens when Safari grants access and the extension background session is still active.
- **Search and choose a model.** **+ → Web search** enables the public hosted search tool for subsequent messages. The composer chip turns it off. Supported models return clickable citations. Choose the model and reasoning effort under **Settings**. **Auto** uses the model default. Settings also shows token usage and context limits.
- **Continue a conversation.** Recent chats includes local history and unsent drafts for the selected connection. Edit or retry starts a separate conversation from that turn. Concurrent changes in the dock and pop-out also preserve separate copies. The header’s **Open chat in a tab** carries the current chat and draft into a standalone view. Copy a message directly or export the chat as Markdown from Settings.
- **Connect an account.** **Continue with ChatGPT** starts OAuth in the browser through the native helper. Eligible accounts can authorize plan usage. Alternatively, add a named API-key connection in the app for separate billing and history. **Replace key** keeps that connection’s chats. OAuth sign-out disconnects locally and reports whether remote revocation succeeded.

The native app and panel each support system, light and dark appearance. An experimental local MCP plugin also exposes the ten Safari tools to compatible desktop threads with their own approval prompts. Existing ChatGPT cloud chats, projects, memories, built-in desktop tab mentions and voice require services outside this independent extension. [Feature comparison](docs/parity.md) · [Desktop plugin setup](plugins/safari-chat/README.md)

Drag the dock's left edge to make chat wider or narrower. It is bounded to 320–840 pixels and leaves at least 320 pixels for the website when space permits. The width is remembered until that page navigates or reloads. Double-click the edge to reset; when focused, Left/Right resize, Shift makes larger steps, Home/End choose the limits, and Enter resets. Escape cancels an active drag. The dock adjusts the website's layout; Safari's actual viewport and CSS media-query width stay unchanged. Common fixed headers and floating controls are kept beside chat. Sites with complex canvas, shadow-DOM, or viewport-sized layouts may work better with **Open chat in a tab**.

Appearance changes apply immediately and save automatically in both interfaces. The companion app's top-right menu offers **System**, **Light**, and **Dark**; its choice is saved on this Mac independently of each Safari profile's panel theme. Panel storage failures remain visible without discarding the selected preview.

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

To test the full extension, open `SafariChat.xcodeproj`, set the same Apple development team for both targets, and configure their shared App Groups/Keychain Sharing capability. The `SAFARI_CHAT_BUNDLE_ID` and `SAFARI_CHAT_GROUP_ID` build settings allow unique identifiers without editing the source. Run the **Safari Chat** scheme, enable it under **Safari → Settings → Extensions**, then choose **Continue with ChatGPT** in the extension. Safari's development setting **Allow Unsigned Extensions** may be required; it does not replace signing entitlements for Keychain/App Groups.

You can quit the companion app after setup. Safari runs its native extension separately and opens the containing app when sign-in is needed. Keep the app bundle installed. After changing the source, stop and run the signed **Safari Chat** scheme again (`⌘R`), restart Safari, and reload the website so it uses the rebuilt extension and content helper. The command-line unsigned build is for verification, not a replacement for your signed installation.

This update is **0.2.0 (build 4)**. Rebuild the signed app, restart Safari, reload the website and check **0.2.0** in Safari’s extension settings. Existing history and the original API-key connection carry forward. Use **Replace key** on that connection to keep its history when rotating a key.

An older preview may open `safarichat://connect` and show “address is invalid” when the companion is not registered. Reload the temporary extension after updating, or rebuild the packaged app. The current button requests a native app launch and reports failures inside the panel without opening a Safari tab.

For a public release, sign and notarize the app, or distribute through the Mac App Store. Standalone users install one app and enable its extension—no additional language runtime or package manager. Optional ChatGPT desktop control also requires its local plugin; its native server runs from the app bundle only while the desktop client owns the connection.

## Remove data and uninstall

In the chat panel, open **Settings** in the header, scroll to **Remove your data**, and choose **Erase local data…** in each Safari profile. Then use **Local data → Erase native data and quit…** in the companion app before uninstalling through Safari and deleting the app. If Safari opens Finder at an Xcode **Debug** folder, quit Safari and Safari Chat, then move **Safari Chat.app** to Trash. That app contains the installed extension; the sibling `.swiftmodule` folders are build outputs. Remove other app copies only if you installed them. Cleanup errors are reported and can be retried. Chats/settings remain browser-contained; credentials use Keychain. Ordinary sign-out does not erase history or registration metadata.

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

Screenshots go to `build/screenshots/`. Add SAFARI_CHAT_WEBKIT=1 on macOS to run the panel in the installed WebKit engine as well. The browser tests use simulated account and model responses and an isolated local web server.

`./scripts/preview-app.sh` renders the production SwiftUI setup view in light, dark, saved-account, multiple-key, API-key entry and compact-window states to the same screenshot directory. It uses inert fixture data without initializing accounts, Safari, OAuth, or app preferences.

After a native build, `./scripts/node.sh tests/mcp-smoke.mjs` checks native stdio discovery and refusal of clients without approval support without accessing Keychain or acting in Safari. `python3 scripts/package-desktop-plugin.py` prepares a local marketplace and `build/Safari-Chat-desktop-plugin.zip`; it does not install or publish the plugin.

The unmodified icon vector is `OpenAI-black-monoblossom.svg` from [OpenAI's official logo assets](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip), stored as `extension/icons/openai-blossom.svg`. The OpenAI mark belongs to OpenAI and is used here for this personal build; it is not covered by this repository's code license. The app remains independently developed.
