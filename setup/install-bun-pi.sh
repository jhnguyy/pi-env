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

# ── Pre-compile patches ─────────────────────────────────────────────────────
# Applied to the dist files in node_modules before bun build --compile bakes
# them into the binary. Patches are idempotent — safe to re-run, and become
# no-ops once upstream fixes land (the old string simply won't match).
#
# To remove a patch: delete its sed line. The next `bun install` restores the
# original file, and the next `./setup.sh` compiles without it.

SYSTEM_PROMPT_JS="$PI_PKG/dist/core/system-prompt.js"

# Guard: dist/cli.js must be a JS source file, not a compiled binary.
# A prior Bun compile bug could write the binary there instead of the outfile.
# If it's an ELF binary, restore it from the npm registry before proceeding.
CLI_JS="$PI_PKG/dist/cli.js"
if [ -f "$CLI_JS" ] && od -An -tx1 -N4 "$CLI_JS" 2>/dev/null | grep -q '7f 45 4c 46'; then
  info "dist/cli.js is a binary — restoring from npm registry"
  curl -sL "https://registry.npmjs.org/@mariozechner/pi-coding-agent/-/pi-coding-agent-${PI_VERSION}.tgz" \
    | tar -xz --strip-components=2 -C "$PI_PKG/dist" package/dist/cli.js
  ok "dist/cli.js restored"
fi

# Fix: system prompt date uses UTC (toISOString) instead of local timezone.
# getFullYear/getMonth/getDate return local-timezone values — no locale dependency.
# Upstream issue: https://github.com/badlogic/pi-mono/issues/1873
if grep -q 'toISOString().slice(0, 10)' "$SYSTEM_PROMPT_JS" 2>/dev/null; then
  sed -i 's|new Date().toISOString().slice(0, 10)|((d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`)(new Date())|' \
    "$SYSTEM_PROMPT_JS"
  ok "Patched system-prompt.js: local timezone date"
else
  info "system-prompt.js: local date patch not needed (already patched or upstream fixed)"
fi

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

# ── Validate compiled output ─────────────────────────────────────────────────
# bun --compile can exit 0 yet write an empty or all-zero file on some
# filesystems (e.g. certain ZFS dataset configurations). Catch this before
# clobbering any existing working binary at $BIN_DIR/pi.
COMPILED_SIZE=$(wc -c < "$TMP_BIN" 2>/dev/null || echo 0)
if [ "$COMPILED_SIZE" -eq 0 ]; then
  echo "  ✗  bun build --compile wrote 0 bytes — silent compilation failure." >&2
  echo "     The compiler exited successfully but produced no output." >&2
  echo "     This is a known Bun bug on some filesystems (e.g. ZFS container roots)." >&2
  echo "     Run manually to see full build output:" >&2
  echo "       bun build '$PI_PKG/dist/bun/cli.js' --compile --external koffi --outfile /tmp/pi-test-bin" >&2
  exit 1
fi
# Check for a valid ELF (Linux) or Mach-O (macOS) magic header.
# An all-zero or truncated output file will not match — this surfaces the
# silent failure that set -e alone cannot catch (bun exits 0 even then).
if ! od -An -tx1 -N4 "$TMP_BIN" 2>/dev/null | grep -qE '7f 45 4c 46|ca fe ba be|ce fa ed fe|cf fa ed fe'; then
  echo "  ✗  bun build --compile produced an invalid binary (${COMPILED_SIZE} bytes)." >&2
  echo "     Expected ELF (Linux) or Mach-O (macOS) magic bytes but got:" >&2
  od -An -tx1 -N4 "$TMP_BIN" >&2 || true
  echo "     This is a known Bun bug on some filesystems. Diagnose with:" >&2
  echo "       bun build '$PI_PKG/dist/bun/cli.js' --compile --external koffi --outfile /tmp/pi-test-bin" >&2
  echo "       od -An -tx1 -N4 /tmp/pi-test-bin" >&2
  exit 1
fi

cp "$TMP_BIN" "$BIN_DIR/pi"
chmod +x "$BIN_DIR/pi"

ok "Binary: $BIN_DIR/pi"

# ── Asset symlinks ───────────────────────────────────────────────────────────
# pi resolves assets relative to dirname(process.execPath) when isBunBinary=true.
# Symlink them from node_modules so they track the installed pi version.
#
# Mirrors the asset layout from upstream scripts/build-binaries.sh:
#   package.json         — pi version metadata
#   README.md            — main documentation (pi system prompt references this)
#   docs/                — feature docs: extensions, themes, skills, sdk, tui, etc.
#   examples/            — extension and sdk examples
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

# PI_PKG assets: "<src-relative-to-PI_PKG> <target-name-in-BIN_DIR>"
PI_PKG_ASSETS=(
  "package.json                    package.json"
  "README.md                       README.md"
  "docs                            docs"
  "examples                        examples"
  "dist/modes/interactive/theme    theme"
  "dist/core/export-html           export-html"
)
for entry in "${PI_PKG_ASSETS[@]}"; do
  read -r src target <<< "$entry"
  link_asset "$PI_PKG/$src" "$BIN_DIR/$target" "$target → node_modules"
done

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
