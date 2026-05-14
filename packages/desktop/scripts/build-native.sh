#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/status-item.swift"
DST_DIR="$ROOT/dist/native"
DST="$DST_DIR/beside-status-item"
BUILD_ARCH="${BESIDE_BUILD_ARCH:-${npm_config_arch:-$(uname -m)}}"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

case "$BUILD_ARCH" in
  arm64|aarch64)
    SWIFT_TARGET="arm64-apple-macosx12.0"
    ;;
  x64|x86_64|amd64)
    SWIFT_TARGET="x86_64-apple-macosx12.0"
    ;;
  *)
    SWIFT_TARGET=""
    ;;
esac

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[desktop] swiftc not found; skipping native status item build" >&2
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
  echo "[desktop] built native status item${SWIFT_TARGET:+ for $SWIFT_TARGET}"
else
  echo "[desktop] native status item build failed" >&2
  rm -f "$DST"
fi

exit 0
