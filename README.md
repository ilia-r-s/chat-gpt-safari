# Safari Chat

An independent Safari companion inspired by [OpenAI's ChatGPT Chrome extension](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg). Built with Swift, Safari Web Extensions, and dependency-free JavaScript. **Development preview; not affiliated with OpenAI.**

## Using side chat

Open **Safari Chat** from the Safari toolbar or press **Command–Shift–Period**. Chat docks along the right edge of the current tab. The page reflows beside it. After a reload, link, or Back/Forward navigation, the panel reconnects to the conversation, including the follow-up draft, streamed reply and any pending approval. Opening the dock shares no page text.

- **Share a page or passage.** Right-click **Ask Safari Chat** to attach the selected text or current page, then review it in the composer. You can also choose **Summarize this page** or **Explain selected text**. A page excerpt can include timestamped captions when a visible video exposes a displayed caption track.
- **Follow browser actions.** A small black pointer with a white outline and blue glow marks the control Safari Chat clicks or the passage it copies. Copying a chat message marks its Copy button. Reduce Motion suppresses decorative animation. The pointer still follows a path you request.
- **Control scrolling and pointer speed.** Try “Scroll down at 320 pixels per second. After 600 pixels, slow to 75 until I stop you.” You can change the speed above the composer while the page is moving. Zero pauses it. Choose **Stop scrolling** or use Escape or your trackpad on the page to take over.
- **Move the pointer or drag.** Try “Move in a zigzag across the page without clicking. Slow down at the last corner.” A path can start in empty space, pass over several elements and change speed between any two points. To draw or drag, start on a canvas or drag handle. The primary button stays down until release. Each path supports up to 128 waypoints and appears in its approval prompt. Websites receive scripted pointer and mouse events. Native file dragging and sites that require trusted input need a person.
- **Type and edit text.** Ask chat to double-click a target, click a field and type at its caret, press an editing key, or select a passage by quoting it. It can copy, paste, delete or replace part of a field, rich-text editor or visible paragraph. On ordinary page text, edits affect the local display and can disappear when the site updates or reloads. Copy and paste use plain text on the Mac clipboard.
- **Set an action allowance.** **Settings → Context and usage → Browser actions per message** accepts 1–100 attempts and defaults to 100. The count below the composer follows the current turn and survives a refresh. At zero, **Continue** starts a fresh allowance and keeps your unsent draft and files.
- **Mention tabs and add files.** Type `@` and choose a Safari tab by title or address. Arrow keys move through suggestions, Enter selects and Escape dismisses. **+ → Add browser tabs** supports multiple selections. Select, drop or paste UTF-8 files. A message can carry six sources. File formatting and independent same-name attachments are preserved within the context limit.
- **Browser approvals.** Click **Ask for approval** beside **+**. Choose **Approve for me** to automatically allow side-chat browser actions and tab listings on accessible sites. For a single trusted website, use the arrow beside **Allow once** on an inline request and choose **Allow for this site**. Manage allowed and blocked hosts in **Settings → Website access**. Each connection starts in ask mode. If a task opens a new tab and Safari needs permission to read it, choose **Allow in Safari…** in the original chat. Granting access resumes the read in the same background tab. Safari controls website access even when **Approve for me** is selected. [Apple’s website permission guide](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)
- **Choose a model and effort.** Both controls sit directly above the message box. **Model default** leaves `reasoning.effort` out of the API request. Choosing a level such as **High** sends that override for the whole turn. Available levels depend on the selected model. [OpenAI’s reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort)
- **Search the web.** Choose **+ → Web search** to enable hosted search. Remove the composer chip to turn it off. Supported models return clickable citations. Token usage and context limits are in Settings.
- **Continue a conversation.** The toolbar reopens the pane on this page. **Recent chats** includes local history and drafts for the selected connection. If you still have a chat tab open from an older version, **Return to source tab** reopens its pane beside the website. Edit or retry starts a separate branch. Copy a message or export the conversation as Markdown from Settings.
- **Connect an account.** **Continue with ChatGPT** starts OAuth in the browser through the native helper. Eligible accounts can authorize plan usage. Choose **Use an OpenAI API key** to open key entry directly in the companion app. API usage is billed to the key’s account, and each named connection has its own local history. **Replace key** keeps that connection’s chats. OAuth sign-out disconnects locally and reports whether remote revocation succeeded.

The native app and panel each support system, light and dark appearance. An experimental local MCP plugin also exposes the ten Safari tools to compatible desktop threads with their own approval prompts. Existing ChatGPT cloud chats, projects, memories, built-in desktop tab mentions and voice require services outside this independent extension. [Feature comparison](docs/parity.md) · [Desktop plugin setup](plugins/safari-chat/README.md)

Drag the divider to resize chat. With the divider focused, the arrow keys adjust its width and Enter resets it. Narrow windows share the available width between the website and chat. Wide tables and controls can scroll inside the page column. Website media queries and scripts still see Safari’s full tab width. A slow-loading pane offers **Retry** and **Close** in place. On a protected page or a site where Safari denies the extension access, the toolbar shows **!** and its tooltip explains how to proceed. A running task can continue across page refreshes while the extension background is alive. Quitting Safari ends live execution.

Panel settings save as you change them. The native app also saves appearance automatically. The companion app's top-right menu offers **System**, **Light**, and **Dark**; its choice is saved on this Mac independently of each Safari profile's panel theme. Panel storage failures remain visible without discarding the selected preview.

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

This update is **0.3.6 (build 11)**. Rebuild the signed app, restart Safari, reload the website and check **0.3.6** in Safari’s extension settings. Existing history and the original API-key connection carry forward. Use **Replace key** on that connection to keep its history when rotating a key.

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
