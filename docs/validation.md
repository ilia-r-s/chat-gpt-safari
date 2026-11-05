# Validation

The goal is reliable, testable behavior, not an unqualified “bug-free” claim.

Latest local verification, 2026-11-06: **45 JavaScript tests and 19 native tests passed**. The earlier isolated browser UI smoke test covers companion setup/retry and cleanup; the latest encoding regression also exercises the actual background bundle with Windows-1252 decoding. The app and embedded extension compile for **arm64 and x86_64**; packaged resources, ZIP integrity, and checksum are checked after packaging. Apple's Safari converter previously accepted the manifest without unsupported-key warnings; the manifest is unchanged. These results do not establish live Safari/account compatibility, native app launch, or signed Keychain cleanup.

## Automated coverage

Run `./scripts/check.sh` for syntax/manifest resource checks, JavaScript unit/integration tests, native XCTest cases, and Xcode/plist validation. Coverage includes:

- Bounded complete-turn context, newest-source deduplication, Unicode estimates, invalid URLs, and settings limits.
- UTF-8/CRLF/multiline SSE framing, partial/failed/incomplete responses, cancellation, invalid data, and admission errors.
- Public API request contract, tool-loop limits, encrypted reasoning continuity, no silent fallback billing, disabled/unknown tools.
- User approvals, stale references/navigation, per-origin read consent, and forbidden URL schemes.
- Synchronous classic background startup, trusted UI sender checks, credential isolation, account changes, persisted streamed answers.
- Status text survives UTF-8 and Windows-1252 decoding of the classic background script. The regression reproduced `Thinkingâ€¦` before the fix; background builds now require ASCII source with Unicode escapes for special characters.
- Missing companion/temporary-extension setup, native launch failure reporting without opening tabs, and resolution restricted to the extension's own containing app, including customized bundle identifiers.
- Safe Markdown rendering, per-account history, chat-count limits, and storage-byte bounds.
- Cleanup write barriers, late responses after erasure, retryable failures, scoped native deletion, symlink protection, and directory locking without files. No tests erase actual user data or Keychain items.
- OAuth PKCE RFC vector, dynamic/returning registration, exact callback matching, duplicate/state/host/expiry checks, form encoding, loopback request validation.
- ES256 and RS256 signature verification, tampered/unsigned tokens, wrong issuer/audience/nonce, expired claims, and missing plan permission.

`tests/ui-smoke.mjs` exercises the real panel DOM with a simulated browser/native transport, and executes content helpers against a real browser DOM. It checks all account buttons with a missing companion, setup dialog/retry without navigation, two consecutive streamed turns, attachments, escaped model HTML, settings, history, narrow layout, cleanup, page extraction, and stale actions. Screenshots are saved under `build/screenshots/`.

`./scripts/build.sh` compiles both app and extension. `./scripts/package.sh` builds the optimized unsigned Release artifact. Apple's converter is also used to verify Safari manifest compatibility; its temporary projects stay under `build/`.

## Still requires a signed Safari installation and live account

These checks cannot be inferred from passing unit tests or an unsigned build:

1. Enable the actual extension in Safari; open/close the panel on HTTPS, HTTP, restricted pages, and sites with strict CSP. Verify toolbar shortcut and selection context menu. Test Connect account with the companion closed, already running, and with its window closed; ensure it opens without a browser tab. Test the temporary folder installation's setup guidance separately.
2. Grant/deny website access; verify cross-origin frames and inaccessible tabs fail clearly. Exercise a navigation while an approval is visible.
3. Complete ChatGPT sign-in, decline plan permission, reconnect, refresh an expiring token, switch accounts/workspaces, and sign out. Confirm shared Keychain/App Groups access with real provisioning.
4. Verify live Responses output/model catalog and usage-limit errors for an eligible ChatGPT account; separately test API-key billing.
5. Exercise native callback timeout/cancellation, sleep/wake, extension background suspension, closing a streaming panel, and Safari restart.
6. Inspect native onboarding layout, permissions and account switching in Safari profiles/private windows. Check VoiceOver/keyboard navigation.
7. Sign/notarize a release and test installation on a separate Mac with no development tools installed.
8. Test erasure in every Safari profile, native Keychain deletion, app quit, failure recovery, and reinstall with a signed build. Inspect only the app's own containers and compare the documented footprint; do not infer zero-trace removal from unit tests.

No live account credentials were used during development. The provided artifact remains unsigned by request.
