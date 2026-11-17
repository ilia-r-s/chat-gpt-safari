#!/bin/sh
set -eu
# The signed native app contains the server; no Node/Python runtime is needed.
safari_chat_app=${SAFARI_CHAT_APP:-'/Applications/Safari Chat.app'}
if [ ! -x "$safari_chat_app/Contents/MacOS/Safari Chat" ]; then
  printf '%s\n' 'Install the signed Safari Chat.app in /Applications, or set SAFARI_CHAT_APP to its app-bundle path.' >&2
  exit 1
fi
exec "$safari_chat_app/Contents/MacOS/Safari Chat" --mcp
