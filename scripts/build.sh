#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build .cache/clang .cache/swift
export CLANG_MODULE_CACHE_PATH="$PWD/.cache/clang"
export SWIFT_MODULECACHE_PATH="$PWD/.cache/swift"
python3 scripts/bundle-background.py
if [ ! -f native/App/AppIcon.icns ]; then
  swift -module-cache-path "$SWIFT_MODULECACHE_PATH" scripts/make-icons.swift "$PWD"
  python3 scripts/make-icns.py
fi
xcodebuild -project SafariChat.xcodeproj -scheme 'Safari Chat' -configuration Debug \
  -derivedDataPath "$PWD/build/DerivedData" -clonedSourcePackagesDirPath "$PWD/.cache/packages" \
  CODE_SIGNING_ALLOWED=NO build "$@"
