#!/usr/bin/env bash
# Build the macOS native AX-text helper. Best-effort: if Swift isn't
# available, we exit 0 silently — the TS plugin will simply degrade to
# OCR-only mode at runtime. We DO NOT fail the workspace install just
# because someone is on Linux or doesn't have CLT installed.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/axtext.swift"
DST_DIR="$ROOT/dist/native"
DST="$DST_DIR/axtext"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "[capture-node] swiftc not found — skipping native AX helper build (run will fall back to OCR-only)." >&2
  exit 0
fi

if [ ! -f "$SRC" ]; then
  exit 0
fi

mkdir -p "$DST_DIR"

# Skip rebuild if binary is newer than source (saves ~20s on every build).
if [ -x "$DST" ] && [ "$DST" -nt "$SRC" ]; then
  exit 0
fi

if swiftc -O "$SRC" -o "$DST" 2>&1; then
  echo "[capture-node] built native/axtext"
else
  echo "[capture-node] swiftc failed; AX helper will be skipped at runtime" >&2
  rm -f "$DST"
fi
exit 0
