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
#   - Compiles it with bun build --compile → ~/.local/bin/pi
#   - Symlinks required assets (package.json, theme/, export-html/) next to binary
#
# ~/.local/bin is the XDG standard user binary dir, auto-added to PATH by most
# Linux distros. On NixOS it is added explicitly in hosts/homelab-agent/default.nix.
#
# Asset symlinks must sit next to the binary regardless of PI_PACKAGE_DIR:
#   getThemesDir() and getExportTemplateDir() resolve relative to
#   dirname(process.execPath) for bun binaries — not overridable via env var.
#
# Idempotent — re-run after `bun install` picks up a new pi version:
#   cd /mnt/tank/code/pi-env && bun install && ./setup/install-bun-pi.sh
#   (or just run ./setup.sh, which calls this automatically)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"

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
# getThemesDir() and getExportTemplateDir() look for theme/ and export-html/
# next to the binary (dirname(process.execPath)) when isBunBinary=true.
# package.json is needed for getPackageDir() fallback.

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
  echo "  ~/.local/bin is not in PATH yet."
  echo "  On NixOS: ensure interactiveShellInit includes \$HOME/.local/bin"
  echo "  On other Linux: add to ~/.profile or ~/.bashrc:"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
