#!/usr/bin/env bash
# Download the pinned QuickJS WASI reactor build into vendor/ and verify it.
# quickjs-ng v0.18.0, qjs-wasi-reactor.wasm (GitHub release asset).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=v0.18.0
SHA256=8afa5d73287af5573613e15d5e633e91d8e096b40676f424f104087bc1416678
OUT=vendor/qjs-wasi-reactor.wasm
mkdir -p vendor
if [ -f "$OUT" ] && echo "$SHA256  $OUT" | shasum -a 256 -c - >/dev/null 2>&1; then exit 0; fi
curl -fsSL -o "$OUT.tmp" "https://github.com/quickjs-ng/quickjs/releases/download/$VERSION/qjs-wasi-reactor.wasm"
echo "$SHA256  $OUT.tmp" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch for $OUT" >&2; rm -f "$OUT.tmp"; exit 1; }
mv "$OUT.tmp" "$OUT"
