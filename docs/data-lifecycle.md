# Data footprint and removal

Safari Chat keeps runtime data in browser-managed storage, Keychain, and its native sandbox containers. It does not install a daemon, login item, updater, extra executable, telemetry store, custom log directory, or a hidden folder in the user's home. Network sessions in the native app are ephemeral. There is no custom credential file or lock file in current builds.

| Data | Location and lifetime | Removal |
| --- | --- | --- |
| Chats, page/file excerpts, settings, drafts, active-chat pointers | Safari's extension `storage.local`; history is bounded to 4 MB, composer drafts to 600 KB total (20 drafts, 200 KB each), and active-chat pointers to 50 | **Erase local data** clears and verifies this storage in the current Safari profile. Repeat in other profiles. |
| OAuth tokens, named API-key connections, account registration metadata, host and session identifiers, optional desktop profile/relay leases | One non-synchronizing Keychain item for this app, with a device-only accessibility class; relay secrets expire after one hour and are removed on clean plugin exit | Cleanup deletes and verifies absence of that exact item. It does not delete the shared Keychain database or other credentials. |
| Desktop MCP requests and approvals | Memory in the client-owned native process and Safari background; a secret-authenticated loopback inbox receives replies | Cancelling/disconnecting stops pending requests. Browser cleanup drains desktop cancellation replies before erasing storage and relay leases. No request/response files or public listener are created. |
| Native coordination | A lock on the App Group directory itself, held only during a vault update | No file is created. Cleanup removes `credentials.lock` left by older development builds. The OS owns container roots/metadata. |
| Native framework caches/preferences | The app's and native extension's own sandbox containers | Extension cleanup handles the extension process's known runtime paths; **Erase native data and quit** handles the containing app. |
| The installed application | The one app bundle and its embedded extension | Uninstall in Safari, remove the app using Finder, and empty its Trash item if desired. |
| Explicit Markdown exports or copied text | The location or clipboard chosen by the user | Separate user-owned output; remove it yourself if no longer wanted. |
| Source checkout, build ZIPs, test screenshots, build caches | The development repository | Not installed runtime data; remove development artifacts separately. The uninstaller never deletes source code. |

## Removal flow

1. In each Safari profile where you used the extension, open its settings and select **Erase local data…**. Confirm the deletion. It stops tasks and blocks new writes so a response or stale panel cannot repopulate cleared storage during that background session. No persistent “uninstalled” marker is written.
2. Check the result. Errors mean cleanup is **incomplete**; retry before uninstalling. In this unsigned preview, native Keychain/container access still requires valid signing, as documented in the installation guide.
3. Select **Open companion app to finish removal**, then **Erase native data and quit…**. The app cancels pending sign-in, clears its own native data, and quits. This action has its own confirmation; opening a URL alone cannot trigger destructive cleanup.
4. Uninstall the extension in Safari's extension settings, remove Safari Chat.app, and handle any other copies/ZIPs/exports you saved. Do not sign in again between cleanup and removal.

Sign-out preserves registration metadata and local chat history. It clears access, identity and refresh tokens for the selected connection and invalidates that session. For OAuth connections the app also attempts to revoke the retiring refresh token and reports the outcome. If remote revocation cannot be confirmed, ChatGPT settings can disconnect the app. API keys are removed from the local connection. Provider-side key management stays with the account owner. Browser cleanup is profile-scoped. Removing the shared native vault disconnects all Safari Chat accounts on this Mac.

Unsent composer text and explicitly attached excerpts autosave locally, separately for each account and conversation. Recent chats includes unsent drafts; deleting a conversation also deletes its draft and active-chat pointers. Editing or retrying creates another local conversation. No draft is sent to the model until a message is submitted. Draft autosave uses the same write barrier as history, so queued saves cannot recreate records after cleanup completes.

The optional desktop plugin is installed in ChatGPT separately from the Safari extension. Remove it in ChatGPT's plugin manager when uninstalling Safari Chat. This app does not delete ChatGPT's plugin files, conversations, or settings. The desktop bridge sends page excerpts and action results into the calling conversation only after the applicable approvals; those conversation records are outside this app's cleanup scope.

## What cannot be promised

“Not a single trace anywhere” is not a guarantee an app can make. macOS and Safari control container metadata, browser sign-in cookies/history, system logs, indexing, application registration, and possibly backups/snapshots. Remote account authorizations and service records are not local files. This app does not attempt to alter those shared databases, clear another site's cookies, or scan/delete unrelated files. Removing an installed bundle also cannot be relied on to run the code that has just been removed; run the cleanup flow first.

Deleting local data is not a promise of forensic overwriting on SSDs, backups, or snapshots. Account access can additionally be revoked from ChatGPT settings; copied/exported data and development artifacts remain under the user's control.

Apple documents that sandboxed apps have access to their own containers and restricted access elsewhere: [App Sandbox file access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox), [sandbox boundaries](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox). The WebExtensions storage API provides scoped clearing rather than deletion of Safari's shared databases: [extension local storage](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/local).

## Validation scope

Tests cover write/erase races, cancellation followed by a late response, idempotent clearing, failed-clear verification, native failure reporting, cleanup confirmation, memory reset, file-free locking, and deletion restricted to fixture sandbox paths. Real signed Safari/Keychain cleanup still needs an integration test; no installed user data was erased during development.
