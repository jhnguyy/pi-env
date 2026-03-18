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
# Asset layout (mirrors upstream scripts/build-binaries.sh):
#   pi resolves assets relative to dirname(process.execPath) when isBunBinary=true.
#   Upstream ships a self-contained directory; we reproduce it with symlinks into
#   node_modules so assets automatically track the installed pi version.
#
#   ~/.local/bin/
#   ├── pi                   ← compiled Bun binary (from dist/bun/cli.js)
#   ├── package.json         → .../pi-coding-agent/package.json
#   ├── theme/               → .../pi-coding-agent/dist/modes/interactive/theme/
#   ├── export-html/         → .../pi-coding-agent/dist/core/export-html/
#   └── photon_rs_bg.wasm    → .../photon-node/photon_rs_bg.wasm
#
# ~/.local/bin is the XDG standard user binary dir, auto-added to PATH by most
# Linux distros. On NixOS it is added explicitly in hosts/homelab-agent/default.nix.
#
# Idempotent — re-run after `bun install` picks up a new pi version:
#   bun install && ./setup/install-bun-pi.sh
#   (or just run ./setup.sh from the repo root, which calls this automatically)

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
# Mirrors upstream: scripts/build-binaries.sh
#   - Entrypoint: dist/bun/cli.js (bun-specific; handles provider registration
#     with traceable inline import() literals)
#   - --external koffi: Windows-only VT input dep, not needed on Linux/macOS

echo ""
echo "Compiling Bun binary..."
mkdir -p "$BIN_DIR"

# Compile to a temp file first — bun --compile has issues writing directly to
# some filesystems (e.g. ZFS container roots). Copy to destination after.
TMP_BIN=$(mktemp /tmp/pi-compile-XXXXXX)
trap 'rm -f "$TMP_BIN"' EXIT

bun build "$PI_PKG/dist/bun/cli.js" \
  --compile \
  --external koffi \
  --outfile "$TMP_BIN"

cp "$TMP_BIN" "$BIN_DIR/pi"
chmod +x "$BIN_DIR/pi"

ok "Binary: $BIN_DIR/pi"

# ── Asset symlinks ───────────────────────────────────────────────────────────
# pi resolves assets relative to dirname(process.execPath) when isBunBinary=true.
# Symlink them from node_modules so they track the installed pi version.
#
# Mirrors the asset layout from upstream scripts/build-binaries.sh:
#   package.json         — pi version metadata
#   theme/               — interactive mode themes
#   export-html/         — HTML export templates
#   photon_rs_bg.wasm    — WebAssembly image processing (photon-node)
#                          photon.js patches fs.readFileSync to load from
#                          dirname(execPath) when the baked-in path fails

link_asset() {
  local src="$1" target="$2" label="$3"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$src" ]; then
    ok "$label"
  else
    ln -sfn "$src" "$target"
    ok "$label (linked)"
  fi
}

PHOTON_PKG="$REPO/node_modules/@silvia-odwyer/photon-node"

link_asset "$PI_PKG/package.json" \
  "$BIN_DIR/package.json" "package.json → node_modules"

link_asset "$PI_PKG/dist/modes/interactive/theme" \
  "$BIN_DIR/theme" "theme/ → node_modules"

link_asset "$PI_PKG/dist/core/export-html" \
  "$BIN_DIR/export-html" "export-html/ → node_modules"

link_asset "$PHOTON_PKG/photon_rs_bg.wasm" \
  "$BIN_DIR/photon_rs_bg.wasm" "photon_rs_bg.wasm → node_modules"

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
