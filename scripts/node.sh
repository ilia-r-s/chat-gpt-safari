#!/bin/sh
set -eu
if [ -n "${SAFARI_CHAT_NODE:-}" ]; then exec "$SAFARI_CHAT_NODE" "$@"; fi
if command -v node >/dev/null 2>&1; then exec node "$@"; fi
# Development fallback only. The shipped app does not require Node or ChatGPT.app.
if [ -x "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" ]; then
  exec "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" "$@"
fi
printf '%s\n' 'Node.js 22+ is needed for development tests. Set SAFARI_CHAT_NODE to a local Node executable.' >&2
exit 1
