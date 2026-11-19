# Working on Safari Chat

Safari Chat is an independent macOS companion for ChatGPT. Use OpenAI’s published side-chat illustration and user flows as the design reference. Verify each comparison against the current guide and keep the product name, account model and Safari permission prompts accurate. Record supported behavior and platform limits in [feature coverage](docs/parity.md). [OpenAI browser extension guide](https://learn.chatgpt.com/docs/chrome-extension)

## Where a change belongs

| Responsibility | Source | Contract |
| --- | --- | --- |
| Accounts and credentials | `native/Shared/`, `native/App/`, `native/Extension/` | The shared Keychain vault owns the active connection and its session generation. New API-key connections get independent IDs. Explicit replacement keeps the selected connection’s history. Native setup and Safari use the same sign-out path. |
| Inference, storage and approvals | `extension/background.js`, `extension/core/` | The background checks the panel’s extension origin, obtains credentials, executes approved tools, and commits completed or interrupted runs. Use the serialized storage write path and expected chat/draft revisions. Preserve both editors’ work on conflict. |
| Dock and page access | `extension/core/chat-dock.js`, `extension/content/` | Reserve space beside the source and reconnect the panel to its background run after navigation. Keep chat in the source tab at every width. Report page access and loading problems there. Opening or restoring chat grants no page context. Capture only an explicitly shared excerpt or the scope authorized for a tool read. |
| Chat UI | `extension/panel/` | Keep conversation and composition together. Use the header for chat navigation and Settings, the composer for attachments, mentions and send/stop, and inline prompts for real approvals. Render untrusted text with text nodes or escaped Markdown. |

## Boundaries to preserve

- Keep modules small and use native platform APIs. The installed app and extension have no runtime package dependencies. Use public OpenAI services and local extension resources. Keep cookies, embedded secrets, remote code and page-controlled native messages out of the integration.
- Recheck the native session generation after asynchronous credential work, before browser action dispatch (including after approval), and at account-owned writes. Cancel obsolete requests on transitions, including a return to the same connection.
- Keep total prompt size, transcripts, tool rounds, deadlines and local history bounded. Preserve source file formatting within those bounds. Tab suggestions list metadata until the user chooses a tab.
- Keep runtime records in Safari storage, the native sandbox and the app-specific Keychain item. Keep build inputs, caches and outputs local to `.build/`, `build/`, `.cache/` and `.venv/`. Avoid custom lock files, global logs or caches, daemons and hidden home-directory folders.
- Preserve the cleanup write barrier, generation checks, narrow deletion scope, verification and failure reporting. Leave browser/system databases, unrelated Keychain items and explicit user exports alone. Describe the actual removal scope without promising forensic erasure.

## Check the changed paths

Read targeted source with `rg`. Keep generated builds out of review. Never read or edit `extension/background.bundle.js`. Keep its source modules ASCII and encode special characters with JavaScript Unicode escapes. Regenerate it with `python3 scripts/bundle-background.py` after background, core or imported content-helper changes.

Run `./scripts/check.sh` for JavaScript, native core and project checks, and `./scripts/build.sh` for the unsigned macOS app. For panel or dock changes, exercise the isolated browser smoke test at normal and minimum widths. For native presentation changes, render `./scripts/preview-app.sh`. Use the signed integration checklist for live Safari, provisioning, OAuth and desktop handoff. State which environment was exercised. [Validation](docs/validation.md) · [Architecture](docs/architecture.md)
