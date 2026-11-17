# Safari Chat

An independent Safari companion inspired by [OpenAI's ChatGPT Chrome extension](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg). Built with Swift, Safari Web Extensions, and dependency-free JavaScript. **Development preview; not affiliated with OpenAI.**

## What is implemented

- Docked chat on websites reserves space on the right and reflows the page on the left. Drag its left edge to resize; closing restores the page layout. Protected pages and windows narrower than 720 pixels open chat in a separate tab. Includes neutral light/dark/system themes, streaming, cancellation, and escaped Markdown.
- The macOS app shares the neutral styling. The app, Safari toolbar, and chat use the OpenAI blossom mark. Its resizable, scrollable setup window includes an app appearance menu, saved-account status, readable connection messages, and a visible Local data section.
- One chat interface with the supported browser tools available in every conversation, and a unified **+** menu for page context, files, browser tabs and web search. The searchable tab picker reads only selected tabs. Attach up to six sources, including small UTF-8 text/code/data files through file selection, drag-and-drop, or paste. Right-click **Ask Safari Chat** or use **Command–Shift–.**
- Ask directly for reading, clicking, filling, choosing dropdowns, changing checkboxes/radio options, scrolling pages/regions, visiting URLs, opening/closing tabs, and listing accessible tabs. Nested horizontal strips and identifiable carousels with ARIA tab navigation are supported, including Apple's shared entertainment gallery controls. Directional scrolling follows the live selected slide if autoplay advanced during approval; changed controls or destinations still invalidate actions. An explicitly chosen offer is clicked separately from gallery navigation. Changes require approval, and the panel shows action progress and concrete execution errors.
- Optional **Web search** uses the public Responses API's hosted search tool, when supported by the selected model/account, and saves clickable source citations with the answer. Search is off by default and does not grant Safari access. API-key mode follows API billing; there is no automatic fallback from ChatGPT plan usage.
- **Continue with ChatGPT** starts sign-in directly from the extension. The installed native helper starts OpenAI's documented browser OAuth flow automatically: loopback callback, PKCE, state/nonce verification, RS256/ES256 ID-token verification, refresh, and Keychain storage. No separate click in the companion setup window is needed. Account management and API-key entry remain available in the native app.
- An **experimental local desktop plugin** exposes ten Safari tools to compatible MCP clients. Desktop requests use ChatGPT-side form elicitation for approvals, while extension requests retain panel approvals. Requires a signed app, a selected Safari profile, and a client supporting local plugins and form elicitation. The live ChatGPT/Safari connection is not yet verified; see [desktop plugin setup](plugins/safari-chat/README.md).
- Local account-separated chat history, search, deletion, and Markdown export. Unsent drafts and their explicit attachments autosave; reopening a panel restores its active chat.
- Edit earlier messages or retry answers in a new conversation while retaining the original. Copy either side of a conversation, see its attached sources, and open chat in a tab directly from the header.
- A removal preparation flow clears browser storage and the app's Keychain record, stops active tasks, and blocks late writes. Native cleanup stays within each process's own sandbox; no custom lock files or global data directories.
- Explicit context budgets, deduplication, bounded tool loops, a cached model catalog, and actual token usage display. **Effort** appears beside the model when supported; **Auto** keeps the model's default. Supported levels come from the account catalog or verified public model documentation. The choice persists in this Safari profile; higher effort can take longer and use more tokens.

**This is not full Chrome-extension parity.** The standalone panel does not sync existing ChatGPT chats, projects, library files, plugins, or memories. Built-in Safari tab mentions, regular ChatGPT remote control, voice, images/PDFs, and downloads are not implemented. There is no artificial Chat/Work capability split. Website access still depends on Safari permissions. See [feature coverage](docs/parity.md).

Use **Edit** under a message to send a revision with the original attachments. **Try again** (or **Retry** on an interrupted answer) starts a new conversation from that turn. Recent chats retains the original conversation and any unsent draft. Drafts also survive switching chats or accounts; **New chat** starts a separate composer. The header's **Open chat in a tab** button carries the current conversation and draft into a standalone tab. Appearance is under **Settings → Appearance**.

For page work, simply describe the task in chat. The assistant can request a read of the page where chat was opened; attaching the page first is optional. Use **+ → Add browser tabs** to select other pages, or **Add current page** to share an excerpt directly. Review the requested action and its field text or destination before allowing it. Use a standalone chat tab for navigation tasks: navigating or closing the page containing an embedded chat is blocked, and a clicked link or submitted form can still unload that embedded panel. Newly opened sites may need website access granted in Safari before they can be read or controlled.

Use **+ → Web search** to enable search for subsequent messages. Its visible composer chip removes it. The model chooses whether a search is needed; availability depends on the model and account. A provider rejection is shown without switching credentials or billing modes.

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

This update is **0.1.2 (build 3)**. Rebuild the signed app, restart Safari, and reload the page. Verify **0.1.2** under Safari's extension settings; the Chat/Work selector is gone and no action-enable setting is needed. Existing conversations and accounts can be kept. If Xcode still shows an old app icon, use **Product → Clean Build Folder** (`⇧⌘K`), then run again. Both build scripts regenerate icons from the bundled vector.

An older preview may open `safarichat://connect` and show “address is invalid” when the companion is not registered. Reload the temporary extension after updating, or rebuild the packaged app. The current button requests a native app launch and reports failures inside the panel without opening a Safari tab.

For a public release, sign and notarize the app, or distribute through the Mac App Store. Standalone users install one app and enable its extension—no additional language runtime or package manager. Optional ChatGPT desktop control also requires its local plugin; its native server runs from the app bundle only while the desktop client owns the connection.

## Remove data and uninstall

In the chat panel, click the bottom-right sliders button (**Settings**), scroll to **Remove your data**, and choose **Erase local data…** in each Safari profile. Then use **Local data → Erase native data and quit…** in the companion app before uninstalling through Safari and deleting the app. If Safari opens Finder at an Xcode **Debug** folder, quit Safari and Safari Chat, then move **Safari Chat.app** to Trash. That app contains the installed extension; the sibling `.swiftmodule` folders are build outputs. Remove other app copies only if you installed them. Cleanup errors are reported and can be retried. Chats/settings remain browser-contained; credentials use Keychain. Ordinary sign-out does not erase history or registration metadata.

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

`./scripts/preview-app.sh` renders the production SwiftUI setup view in light, dark, saved-account, API-key, and compact-window states to the same screenshot directory. It uses inert fixture data without initializing accounts, Safari, OAuth, or app preferences.

After a native build, `./scripts/node.sh tests/mcp-smoke.mjs` checks native stdio discovery and refusal of clients without approval support without accessing Keychain or acting in Safari. `python3 scripts/package-desktop-plugin.py` prepares a local marketplace and `build/Safari-Chat-desktop-plugin.zip`; it does not install or publish the plugin.

The unmodified icon vector is `OpenAI-black-monoblossom.svg` from [OpenAI's official logo assets](https://cdn.openai.com/brand/OpenAI-Logos-2025.zip), stored as `extension/icons/openai-blossom.svg`. The OpenAI mark belongs to OpenAI and is used here for this personal build; it is not covered by this repository's code license. The app remains independently developed.
