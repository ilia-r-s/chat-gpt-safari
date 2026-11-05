# Architecture

## Runtime boundaries

1. **SwiftUI app** handles onboarding, account selection, API-key entry, and browser-hosted OAuth. A temporary Network.framework listener binds only to `127.0.0.1`, validates the callback host/path/state, and closes after one callback or ten minutes. The exact callback URI is used for the code exchange. OpenAI's public signing keys validate identity before credentials are committed.
2. **Native Safari extension** handles a fixed allowlist of native messages. Shared Keychain holds the protected vault; a lock on the App Group directory serializes updates without creating a lock file. Reads do not open the group container. The background script receives a short-lived bearer credential only when needed. Refresh tokens and API-key input never appear in the page or panel UI.
3. **Background script** owns API requests and browser capabilities. It accepts messages only from the exact extension panel URL and extension ID. Native credential replies are never forwarded through the panel's RPC. Requests use the public Responses API, omit browser cookies, reject redirects, and never use private ChatGPT endpoints.
4. **Content helpers** run in Safari's isolated world. Page extraction skips hidden text, scripts, controls' values, and editable fields. An extension-origin iframe isolates the chat UI from website styles/scripts. HTML output is escaped before a small Markdown subset is rendered. There is no page-to-native `postMessage` bridge.

**Connect account** sends the fixed `app.open` native request. The native handler resolves the app embedding its own extension, checks the app's bundle identifier, and launches that exact bundle through `NSWorkspace` without adding a recent item. No caller-supplied URL or path is accepted, and no custom-scheme Safari tab is opened. An unavailable companion or failed launch shows retryable setup guidance. A temporary folder installation has no native bridge and cannot perform sign-in; the packaged app and its embedded extension are needed.

## Context and runtime efficiency

- Default budget: 12,000 characters per page, 48,000 input characters, eight recent turns, six browser-tool rounds. These are character budgets, not exact token counts; serialization/schema overhead is separately bounded. The UI labels pre-request token numbers as estimates; provider-reported usage is shown after responses.
- Only explicit attachments enter the prompt. Newest snapshots replace earlier snapshots of the same source. Older complete turns are removed before newer turns. Sources remain untrusted user data, separate from assistant instructions. URLs omit query/fragment values in model context.
- Extraction stops at its character budget or 20,000 visited text nodes and returns at most 60 interactive element references. No screenshots, whole DOM dumps, automatic tab sweeps, embeddings, or paid summarization calls.
- One compact namespaced browser function; no parallel browser calls. Every API request has `store: false` and `stream: true`. Reasoning continuity is carried as encrypted output only inside an active bounded tool loop.
- Model catalogs cache for five minutes per account. UTF-8 stream decoding is incremental. The UI paints at most once per animation frame and parses Markdown at completion. The output-size limit is 120,000 characters. A task expires after five minutes, including approval wait time.
- The classic background bundle is ASCII with JavaScript Unicode escapes for special characters, so its status/approval text is independent of Safari's script decoding. API response streams and user content retain their Unicode text.
- History is limited to 50 chats, 80 messages per chat, approximately 400 KB per chat, and 4 MB total. Old chats are evicted before a write hits the extension quota. No background polling, third-party analytics, fonts, UI framework, or runtime libraries.

## Permission model

The manifest requests `activeTab`, scripting, storage, context menus, native messaging, and the public API host. Other websites are optional. Safari grants website access after an explicit toolbar gesture. The tab picker shows only accessible tabs; this preview does not silently request access to all websites.

Attaching a page authorizes its context for the current message. Tool reads of a new website require approval, and read consent is scoped to the tab **and origin**. Click/fill/navigation/close/open operations require approval. A fresh read provides opaque element IDs. The executor rechecks URL, node connectivity, label, visibility, and sensitive-field status immediately before writing, and invalidates all element references after a write. Password, payment, file-upload and token fields are excluded. Website JavaScript can still mutate a DOM between checks; this is a DOM tool, not a CDP debugger or a guaranteed transaction.

The content panel is per-page and closes on full navigation. Use a standalone extension tab if a workflow needs the chat to remain open across navigations. Background completion/cancellation persists partial text when the process remains available. A browser crash or forced extension termination can still lose the newest unfinished output.

## Accounts and local data

Each OAuth registration retains its issued client ID and verified subject. Account/workspace registrations remain separate, even when emails match. Sign-out clears that account's tokens and active selection while retaining registration metadata; remote revocation happens in ChatGPT settings. A valid identity without `chatgpt.tokens.use.direct` does not enable inference. API-key mode is explicitly separate and never a silent billing fallback.

The native account picker is shared across this app's Safari profiles; browser-local chat storage follows Safari's extension storage behavior. This preview has one API-key slot. Chats and source excerpts live locally until deletion/eviction; sign-out does not delete history. OAuth refresh is single-flight per account within a native process; atomic vault updates reject credential changes that happen during refresh.

**Erase local data** is separate from sign-out: it stops work, drains already-started storage writes, rejects pending/new writes, clears and verifies browser storage, deletes the entire app-specific Keychain record (including registration metadata and host ID), and removes the legacy development lock file. Native cleanup touches only an allowlist of cache/preferences paths in the current process's verified sandbox container. It refuses redirected ancestors and never deletes another app's containers or Safari's databases. Existing sign-in/refresh operations must still match the original vault before writing. Cleanup failures remain visible and retryable. Finish with the companion app's **Erase native data and quit** action, then uninstall. See [data lifecycle and removal](data-lifecycle.md) for exact scope and platform limits.

## References verified 2026-11-05/06

- [Official Chrome extension behavior](https://learn.chatgpt.com/docs/chrome-extension)
- [Open-source sign-in contract](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Current API limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Safari native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)
- [Safari permissions](https://developer.apple.com/documentation/safariservices/managing-safari-web-extension-permissions)
