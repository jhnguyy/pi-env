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
#
# ~/.local/bin is the XDG standard user binary dir, auto-added to PATH by most
# Linux distros. On NixOS it is added explicitly in hosts/homelab-agent/default.nix.
#
# Asset resolution (package.json, theme/, export-html/) is handled by the
# PI_PACKAGE_DIR environment variable pointing at pi-env's node_modules —
# no symlinks next to the binary are needed.
#
# Idempotent — re-run after `bun install` picks up a new pi version:
#   cd /mnt/tank/code/pi-env && bun install && ./setup/install-bun-pi.sh
#   (or just run ./setup.sh, which calls this automatically)

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"

ok()   { echo "  ✓  $1"; }
info() { echo "  ·  $1"; }
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
