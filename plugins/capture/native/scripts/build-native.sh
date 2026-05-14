#!/usr/bin/env bash
# Build the native capture sidecar. Best-effort: if the host cannot
# build this platform's helper, leave the JS plugin intact and let it
# fail clearly at runtime with fallback guidance.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/capture.swift"
BUILD_ARCH="${BESIDE_BUILD_ARCH:-${npm_config_arch:-$(uname -m)}}"

case "$(uname -s)" in
  Darwin)
    PLATFORM="darwin"
    ;;
  *)
    echo "[capture-native] no native helper build for $(uname -s) yet; skipping"
    exit 0
    ;;
esac

case "$BUILD_ARCH" in
  arm64|aarch64)
    ARCH="arm64"
    SWIFT_TARGET="arm64-apple-macosx12.0"
    ;;
  x64|x86_64|amd64)
    ARCH="x64"
    SWIFT_TARGET="x86_64-apple-macosx12.0"
    ;;
  *)
    ARCH="$BUILD_ARCH"
    SWIFT_TARGET=""
    ;;
esac

DST_DIR="$ROOT/dist/native/${PLATFORM}-${ARCH}"
DST="$DST_DIR/beside-capture"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[capture-native] swiftc not found; skipping native helper build" >&2
  exit 0
fi

mkdir -p "$DST_DIR"

if [ -z "${BESIDE_BUILD_ARCH:-}" ] && [ -x "$DST" ] && [ "$DST" -nt "$SRC" ]; then
  exit 0
fi

SWIFT_ARGS=(-O)
if [ -n "$SWIFT_TARGET" ]; then
  SWIFT_ARGS+=(-target "$SWIFT_TARGET")
fi

if swiftc "${SWIFT_ARGS[@]}" "$SRC" -o "$DST" 2>&1; then
  chmod +x "$DST"
  echo "[capture-native] built native helper at $DST"
else
  echo "[capture-native] native helper build failed; plugin will report unavailable at runtime" >&2
  rm -f "$DST"
fi

exit 0
