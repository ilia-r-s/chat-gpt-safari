# Feature coverage

Reference: [OpenAI ChatGPT Chrome extension](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg), store version 1.26.1102.11740, inspected 2026-11-05.

| Capability | This development build |
| --- | --- |
| Side chat | Extension-origin panel on ordinary pages; standalone tab fallback when injection is unavailable. Not Safari's built-in sidebar. |
| ChatGPT login | Documented open-source OAuth flow implemented. Needs signed native app and a live account test. Available authentication providers are determined by OpenAI's browser login page. |
| API-key login | Native secure entry and Keychain storage implemented; live account test outstanding. |
| Account/workspace selection | Separate issued OAuth registrations, native account picker, refresh, reconnect, sign-out. |
| Model selection and streamed chat | Account model catalog and public Responses API integration implemented; simulated integration tests pass. |
| Page/selection context | Explicit extraction, context menu, bounded attachments, source deduplication. |
| Tab mentions | Accessible-tab picker attaches context. No integration with the official desktop app's `@Safari` surface. |
| Browser actions | DOM read/click/fill/navigation/open/close/list with per-action approval. Browser actions are off by default. Canvas, OS dialogs, closed shadow DOM, cross-origin frames, and full CDP parity are not implemented. |
| Conversation history | Local history/search/export. Existing ChatGPT cloud conversations do not sync through the public identity/plan API. |
| Data removal | Explicit browser/native cleanup, no custom lock files, blocked late writes, verified storage clearing, and visible failures. OS/browser records and backups are outside its scope; no automatic zero-trace uninstall promise. |
| Plugins, memories, local filesystem | Official ChatGPT desktop integration is not reproduced; the public sign-in scope does not expose existing account context. |
| Files | Explicit small text-file attachments. PDF/image/audio/video inputs, uploads, download management, and browser history are not implemented. |
| YouTube transcript | No special transcript extraction; only ordinary visible page text. |
| Voice, image generation, hosted tools | Not implemented. Several hosted tools are unsupported by the documented plan-usage preview. |
| Cross-page task continuity | Full navigation removes the injected panel. A standalone panel tab can keep a task open. There is no automatic panel reinjection or persistent daemon. |
| macOS installation | One native app contains the extension. Unsigned artifact provided; signing/notarization is still needed for normal installation. |
| iPhone / iPad | Not targeted in this macOS preview. |

The supported public API is useful for a standalone Safari assistant, but does not provide the full official Chrome extension's private desktop/web integration. Do not market this build as an official extension or a complete replacement. [Public flow limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [identity/plan scope](https://developers.openai.com/siwc/token-sharing-open-source).
