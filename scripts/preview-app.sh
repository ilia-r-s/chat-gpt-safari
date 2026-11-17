#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p build .cache/clang .cache/swift
export CLANG_MODULE_CACHE_PATH="$PWD/.cache/clang"
export SWIFT_MODULECACHE_PATH="$PWD/.cache/swift"
swiftc -module-cache-path "$SWIFT_MODULECACHE_PATH" \
  native/App/SetupContent.swift tests/app-preview.swift -o build/app-preview
./build/app-preview
