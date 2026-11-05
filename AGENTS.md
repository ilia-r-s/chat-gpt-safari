# Working in this repository

This is an independent Safari companion for ChatGPT. Do not imply OpenAI affiliation or feature parity that has not been verified.

## Read only what the task needs
- `extension/background.js`: extension events, trusted UI messages, permissions.
- `extension/core/`: bounded context, Responses streaming, browser tools, storage.
- `extension/panel/`: chat UI. `extension/content/`: page extraction and panel mount.
- `native/Shared/`: Keychain, OAuth contract and ID-token validation.
- `native/App/`: macOS onboarding and loopback sign-in.
- `native/Extension/`: Safari native messaging.
- `docs/architecture.md` and `docs/parity.md`: boundaries and current coverage.

## Constraints
- Prefer small modules, native platform APIs, and no runtime dependencies.
- Preserve opt-in page context, total input bounds, bounded tool loops, cancellation, and account isolation.
- No cookies, private ChatGPT APIs, embedded secrets, remote code, or page-controlled native messages.
- Use a dedicated extension origin for chat UI; render untrusted output as text/escaped Markdown.
- Keep caches/builds/dependencies local: `.build/`, `build/`, `.cache/`, `.venv/`.
- Keep runtime data in Safari storage and native sandbox containers; credentials belong in Keychain. No custom lock files, global caches/logs, daemons, or hidden home-directory folders. Explicit user exports are separate.
- Preserve cleanup's write barrier, account-generation checks, failure reporting, and narrow deletion scope. Never claim forensic erasure or remove system/browser databases, unrelated Keychain items, or user exports.
- Do not read generated builds or entire directories into LLM context. Use `rg`, then targeted reads.
- `extension/background.bundle.js` is generated; never read or edit it. Regenerate with `python3 scripts/bundle-background.py` after background/core changes.
- Keep background source modules ASCII; use JavaScript Unicode escapes for special characters so Safari's classic script encoding cannot corrupt them.

## Checks
- `./scripts/check.sh`: JavaScript syntax, unit/integration tests, native core tests, project validation.
- `./scripts/build.sh`: unsigned macOS build. Signing/install instructions are in README.
- Test meaningful failure cases. Never report live OAuth or Safari integration as tested unless exercised.
