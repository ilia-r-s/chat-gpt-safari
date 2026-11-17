#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build .cache/clang .cache/swift
export CLANG_MODULE_CACHE_PATH="$PWD/.cache/clang"
export SWIFT_MODULECACHE_PATH="$PWD/.cache/swift"
python3 scripts/bundle-background.py
swift -module-cache-path "$SWIFT_MODULECACHE_PATH" scripts/make-icons.swift "$PWD"
python3 scripts/make-icns.py
xcodebuild -project SafariChat.xcodeproj -scheme 'Safari Chat' -configuration Release \
  -derivedDataPath "$PWD/build/DerivedData" -clonedSourcePackagesDirPath "$PWD/.cache/packages" \
  CODE_SIGNING_ALLOWED=NO build
stage=$(mktemp -d "$PWD/build/package.XXXXXX")
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/unsigned-package"
ditto 'build/DerivedData/Build/Products/Release/Safari Chat.app' "$stage/unsigned-package/Safari Chat.app"
cp docs/INSTALL-UNSIGNED.txt "$stage/unsigned-package/READ-ME-FIRST.txt"
ditto -c -k --keepParent "$stage/unsigned-package" "$stage/Safari-Chat-unsigned.zip"
mv "$stage/Safari-Chat-unsigned.zip" build/Safari-Chat-unsigned.zip
shasum -a 256 build/Safari-Chat-unsigned.zip > build/Safari-Chat-unsigned.zip.sha256
printf '%s\n' 'Created build/Safari-Chat-unsigned.zip (unsigned development artifact).'
