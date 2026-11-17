# Safari Chat desktop plugin (experimental)

This local MCP plugin lets a compatible desktop ChatGPT Work/Codex thread call the Safari Chat extension. Requests use the extension's browser-action executor; permission prompts return to the calling client through MCP form elicitation. It does not register Safari as one of OpenAI's built-in supported browsers, reuse a private ChatGPT login session, or provide regular ChatGPT remote control.

## Setup

1. Build and install **Safari Chat.app** with matching signing, App Groups and Keychain Sharing for its app and extension. An unsigned build can test protocol discovery but cannot establish the secure native bridge.
2. Enable the extension and grant access to the websites you want to use. In the chosen Safari profile, open **Settings → ChatGPT desktop control**. Only one profile is paired at a time; no API account is required for desktop tool calls.
3. Run `python3 scripts/package-desktop-plugin.py` in the source repository. It prepares `build/desktop-marketplace` and `build/Safari-Chat-desktop-plugin.zip` without installing or publishing them.
4. Add that local marketplace using the supported desktop plugin workflow (or `codex plugin marketplace add ./build/desktop-marketplace`), then install **safari-chat** from that source and start a new local thread. The launcher expects `/Applications/Safari Chat.app`; a developer may set `SAFARI_CHAT_APP` to a different signed app-bundle path in the client's environment.
5. Mention the Safari Chat plugin and ask it to list tabs, read a page, or perform a specific task. Approve reads and changes in the calling app. If the client does not advertise MCP form elicitation, the server refuses tool execution. Never replace that check with unconditional approval.

The plugin includes no Node/Python dependency or separate background service. Its stdio server runs inside the native app executable only for the lifetime of the client connection. Reconnect after a one-hour lease expires, changing Safari profiles, or erasing local data. Safari permissions can still prevent access to a newly opened site; grant access in Safari before retrying.

## Tools and limits

The ten tools cover reading, clicking, text filling, native dropdown selection, checkbox/radio state, scrolling, opening tabs, visiting URLs, closing tabs, and listing accessible tabs. Scroll supports native page/region scrolling and identifiable carousels through their own ARIA tab controls; use the listed directions. Read before acting and read again after changes. Unsupported controls, sensitive fields, stale references, invalid URLs, denied permissions, and cancelled actions fail visibly. Canvas, arbitrary drag-only galleries, OS dialogs, closed shadow DOM, and cross-origin frames are outside this implementation.

Normal MCP annotations inform the host's policy; the explicit form-elicitation approval remains authoritative in this bridge. ChatGPT may also show its own plugin/tool approval. A tool cannot decide to approve its own pending action by passing an argument.

Regular ChatGPT conversations do not receive a hosted MCP endpoint or a Secure MCP Tunnel from this package. Supporting that surface needs an authenticated remote connection and separate deployment work. Local plugin support and permissions depend on the client and workspace. Public distribution of local MCP plugins also requires OpenAI's desktop-plugin submission eligibility.

## Verification status

The native stdio discovery/refusal smoke test, bounded loopback parser tests, background approval/account/cleanup tests, DOM interaction tests, and unsigned build can run locally. They do not verify the signed Safari native port, ChatGPT's live elicitation UI, or plugin installation in a real account. Those integration checks remain required before treating this as a working end-to-end desktop connection.

References checked 2026-11-17: [local plugin packaging](https://developers.openai.com/plugins/build/plugins), [desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only), [MCP tools and elicitation](https://developers.openai.com/plugins/build/mcp-server), [Safari native messaging](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension).
