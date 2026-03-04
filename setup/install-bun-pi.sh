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
#   - Finds the npm-installed @mariozechner/pi-coding-agent package
#   - Compiles it with bun build --compile → ~/.pi/bin/pi
#   - Symlinks required assets (package.json, theme/, export-html/) next to binary
#
# Add to PATH (once, in ~/.profile or ~/.bashrc):
#   export PATH="$HOME/.pi/bin:$PATH"
#
# Idempotent — re-run after updating pi:
#   npm install -g @mariozechner/pi-coding-agent && ./setup/install-bun-pi.sh

set -euo pipefail

BIN_DIR="${PI_BIN_DIR:-$HOME/.pi/bin}"

ok()   { echo "  ✓  $1"; }
info() { echo "  ·  $1"; }
link() { echo "  →  $1"; }
err()  { echo "  ✗  $1" >&2; exit 1; }

# ── Find the npm package ─────────────────────────────────────────────────────

find_package_dir() {
  # Method 1: npm root -g (most reliable when npm is in PATH)
  local npm_root
  npm_root=$(npm root -g 2>/dev/null) && \
    [ -f "$npm_root/@mariozechner/pi-coding-agent/package.json" ] && \
    echo "$npm_root/@mariozechner/pi-coding-agent" && return 0

  # Method 2: derive from the pi symlink
  #   npm global: PREFIX/bin/pi -> ../lib/node_modules/PACKAGE/dist/cli.js
  local pi_bin pi_link prefix candidate
  pi_bin=$(command -v pi 2>/dev/null) || return 1
  pi_link=$(readlink "$pi_bin" 2>/dev/null) || return 1
  prefix=$(dirname "$pi_bin")
  candidate=$(realpath "$prefix/$pi_link" 2>/dev/null) || return 1
  # realpath gives us .../PACKAGE/dist/cli.js — strip dist/cli.js
  candidate=$(dirname "$(dirname "$candidate")")
  [ -f "$candidate/package.json" ] && echo "$candidate" && return 0

  return 1
}

echo "Finding @mariozechner/pi-coding-agent..."
PI_PKG=$(find_package_dir) || \
  err "Cannot find @mariozechner/pi-coding-agent. Install first:
       npm install -g @mariozechner/pi-coding-agent"

ok "Package: $PI_PKG"

PI_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$PI_PKG/package.json','utf8')).version)" 2>/dev/null || echo "unknown")
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
