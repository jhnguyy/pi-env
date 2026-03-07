#!/usr/bin/env bash
# setup/install-bun-pi.sh — Compile pi as a Bun standalone binary
#
# Why Bun binary instead of npm global:
#   When pi is a Bun compiled binary (isBunBinary=true), its extension loader
#   uses virtualModules + tryNative=false instead of jiti's Node.js resolution
#   chain. This avoids CJS/ESM format conflicts in extensions that use
#   Bun-specific APIs (import.meta.dir, etc.) or have mixed module patterns.
#
# What it does:
#   - Uses @mariozechner/pi-coding-agent from the repo's node_modules (version
#     pinned by bun.lock — run `bun install` first if node_modules is absent)
#   - Compiles it with bun build --compile → ~/.pi/bin/pi
#   - Symlinks required assets (package.json, theme/, export-html/) next to binary
#
# Add to PATH (once, in ~/.profile or ~/.bashrc):
#   export PATH="$HOME/.pi/bin:$PATH"
#
# Idempotent — re-run after `bun install` picks up a new pi version:
#   cd ~/pi-env && bun install && ./setup/install-bun-pi.sh
#   (or just run ./setup.sh, which calls this automatically)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${PI_BIN_DIR:-$HOME/.pi/bin}"

ok()   { echo "  ✓  $1"; }
info() { echo "  ·  $1"; }
link() { echo "  →  $1"; }
err()  { echo "  ✗  $1" >&2; exit 1; }

# ── Locate the repo-local package ───────────────────────────────────────────

PI_PKG="$REPO/node_modules/@mariozechner/pi-coding-agent"

[ -f "$PI_PKG/package.json" ] || \
  err "node_modules not found. Run 'bun install' in $REPO first."

ok "Package: $PI_PKG"

PI_VERSION=$(bun -e "console.log(require('$PI_PKG/package.json').version)" 2>/dev/null || echo "unknown")
info "Version: $PI_VERSION"

# ── Compile binary ───────────────────────────────────────────────────────────

echo ""
echo "Compiling Bun binary..."
mkdir -p "$BIN_DIR"

# Compile to a temp file first — bun --compile has issues writing directly to
# some filesystems (e.g. ZFS container roots). Copy to destination after.
TMP_BIN=$(mktemp /tmp/pi-compile-XXXXXX)
trap 'rm -f "$TMP_BIN"' EXIT

bun build "$PI_PKG/dist/cli.js" \
  --compile \
  --outfile "$TMP_BIN"

cp "$TMP_BIN" "$BIN_DIR/pi"
chmod +x "$BIN_DIR/pi"

ok "Binary: $BIN_DIR/pi"

# ── Asset symlinks ───────────────────────────────────────────────────────────
#
# When pi is a Bun binary, getPackageDir() = dirname(process.execPath),
# so package.json, theme/, and export-html/ must sit next to the binary.

echo ""
echo "Linking assets..."

ln -sfn "$PI_PKG/package.json" "$BIN_DIR/package.json"
link "package.json"

ln -sfn "$PI_PKG/dist/modes/interactive/theme" "$BIN_DIR/theme"
link "theme/"

ln -sfn "$PI_PKG/dist/core/export-html" "$BIN_DIR/export-html"
link "export-html/"

# ── PATH check ───────────────────────────────────────────────────────────────

echo ""
echo "Done. pi $PI_VERSION ready at $BIN_DIR/pi"

if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$BIN_DIR"; then
  echo ""
  echo "  Add $BIN_DIR to PATH (once):"
  echo "    echo 'export PATH=\"\$HOME/.pi/bin:\$PATH\"' >> ~/.profile"
  echo ""
  echo "  Then reload your shell or run:"
  echo "    export PATH=\"\$HOME/.pi/bin:\$PATH\""
fi
