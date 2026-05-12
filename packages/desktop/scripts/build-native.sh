#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/status-item.swift"
DST_DIR="$ROOT/dist/native"
DST="$DST_DIR/beside-status-item"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[desktop] swiftc not found; skipping native status item build" >&2
  exit 0
fi

mkdir -p "$DST_DIR"
if [ -x "$DST" ] && [ "$DST" -nt "$SRC" ]; then
  exit 0
fi

if swiftc -O "$SRC" -o "$DST" 2>&1; then
  chmod +x "$DST"
  echo "[desktop] built native status item"
else
  echo "[desktop] native status item build failed" >&2
  rm -f "$DST"
fi

exit 0
