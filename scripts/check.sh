#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .cache/clang .cache/swift .cache/swiftpm .cache/swiftpm-config .cache/swiftpm-security
export CLANG_MODULE_CACHE_PATH="$PWD/.cache/clang"
export SWIFT_MODULECACHE_PATH="$PWD/.cache/swift"
python3 scripts/bundle-background.py --check
./scripts/node.sh scripts/check.mjs
./scripts/node.sh --test tests/*.test.js
swift test --disable-sandbox --scratch-path "$PWD/.build" \
  --cache-path "$PWD/.cache/swiftpm" --config-path "$PWD/.cache/swiftpm-config" \
  --security-path "$PWD/.cache/swiftpm-security" \
  -Xswiftc -module-cache-path -Xswiftc "$SWIFT_MODULECACHE_PATH"
plutil -lint SafariChat.xcodeproj/project.pbxproj native/App/Info.plist native/Extension/Info.plist native/App/App.entitlements native/Extension/Extension.entitlements
