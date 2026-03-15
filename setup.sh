#!/usr/bin/env bash
# pi-env dotfiles setup
#
# Idempotent. Re-run after git pull to pick up new extensions/skills.
#
# What it does:
#   1. bun install (frozen lockfile)
#   2. Compile pi binary + symlink assets (setup/install-bun-pi.sh)
#   3. Register pi-env as a pi package in settings.json
#   4. Symlink AGENTS.md → ~/.pi/agent/AGENTS.md
#   5. Symlink roles → ~/.agents/roles
#   6. Source tmux theme from ~/.tmux.conf
#   7. Symlink VS Code Gruvbox extension → ~/.vscode/extensions/
#   8. Install git post-merge hook
#
# Extensions and skills are loaded by pi's package manager from the repo
# directory — no per-extension or per-skill symlinks needed. Local extensions
# in ~/.pi/agent/extensions/ coexist via pi's auto-discovery.
#
# What stays local (never touched):
#   ~/.pi/agent/auth.json, settings.json, models.json, sessions/
#   ~/.pi/agent/extensions/my-extension/ (local-only extensions)

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"

PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
AGENTS_DIR="${AGENTS_DIR:-$HOME/.agents}"

ok()     { echo "  ✓  $1"; }
linked() { echo "  →  $1"; }
skip()   { echo "  —  $1 (exists locally, skipping)"; }
relink() { echo "  ↺  $1 (relinked)"; }

# ── Dependencies ─────────────────────────────────────────────────────────────
# bun install downloads @mariozechner/pi-coding-agent at the version pinned in
# bun.lock. install-bun-pi.sh then compiles the binary from that local copy.

echo "Dependencies"
echo "------------"
(cd "$REPO" && bun install --frozen-lockfile)
ok "node_modules up to date"

link_path() {
  local src="$1" target="$2" label="$3"
  if [ -L "$target" ]; then
    [ "$(readlink "$target")" = "$src" ] && ok "$label" && return
    ln -sfn "$src" "$target" && relink "$label"
  elif [ -e "$target" ]; then
    skip "$label"
  else
    ln -sfn "$src" "$target" && linked "$label"
  fi
}

# ── Package registration ────────────────────────────────────────────────────
# Register pi-env as a local pi package so pi's package manager discovers
# extensions and skills directly from the repo. No per-item symlinks needed.

echo ""
echo "Package registration"
echo "--------------------"
SETTINGS_FILE="$PI_AGENT_DIR/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  # Check if pi-env repo path is already in the packages array
  if bun -e "
    const s = JSON.parse(require('fs').readFileSync('$SETTINGS_FILE', 'utf-8'));
    const pkgs = s.packages || [];
    process.exit(pkgs.some(p => (typeof p === 'string' ? p : p.source) === '$REPO') ? 0 : 1);
  " 2>/dev/null; then
    ok "pi-env registered in settings.json packages"
  else
    # Add the repo path to the packages array
    bun -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
      s.packages = s.packages || [];
      s.packages.push('$REPO');
      fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(s, null, 2) + '\n');
    " 2>/dev/null
    linked "pi-env added to settings.json packages"
  fi
else
  skip "settings.json not found — copy setup/settings.template.json first"
fi

# ── Roles (entire directory, no local override) ──────────────────────────────
# Roles are a pi-env concept (not a pi primitive), so they still need symlinking.

echo ""
echo "Roles"
echo "-----"
mkdir -p "$AGENTS_DIR"
link_path "$REPO/.agents/roles" "$AGENTS_DIR/roles" "~/.agents/roles"

# ── AGENTS.md ────────────────────────────────────────────────────────────────
# pi doesn't load AGENTS.md from packages, so this still needs symlinking.

echo ""
echo "AGENTS.md"
echo "---------"
link_path "$REPO/AGENTS.md" "$PI_AGENT_DIR/AGENTS.md" "~/.pi/agent/AGENTS.md"

# ── Test utilities ───────────────────────────────────────────────────────────

echo ""
echo "Test utilities"
echo "--------------"
mkdir -p "$PI_AGENT_DIR/extensions/__tests__"
link_path \
  "$REPO/.pi/extensions/__tests__/test-utils.ts" \
  "$PI_AGENT_DIR/extensions/__tests__/test-utils.ts" \
  "~/.pi/agent/extensions/__tests__/test-utils.ts"
link_path \
  "$REPO/.pi/extensions/__tests__/loader.test.ts" \
  "$PI_AGENT_DIR/extensions/__tests__/loader.test.ts" \
  "~/.pi/agent/extensions/__tests__/loader.test.ts"

# ── Tmux theme ───────────────────────────────────────────────────────────────
# Source the Gruvbox tmux theme from ~/.tmux.conf. The theme file lives in the
# repo so it's version-controlled; ~/.tmux.conf just sources it.

echo ""
echo "Tmux theme"
echo "----------"
TMUX_THEME_SRC="$REPO/setup/tmux-gruvbox.conf"
TMUX_CONF="$HOME/.tmux.conf"
SOURCE_LINE="source-file $TMUX_THEME_SRC"
if [ -f "$TMUX_CONF" ] && grep -qF "$SOURCE_LINE" "$TMUX_CONF"; then
  ok "tmux-gruvbox.conf sourced from ~/.tmux.conf"
elif [ -f "$TMUX_CONF" ]; then
  printf '\n%s\n' "$SOURCE_LINE" >> "$TMUX_CONF"
  linked "tmux-gruvbox.conf appended to ~/.tmux.conf"
else
  printf '%s\n' "$SOURCE_LINE" > "$TMUX_CONF"
  linked "tmux-gruvbox.conf → new ~/.tmux.conf"
fi

# ── VS Code theme ────────────────────────────────────────────────────────────
# Symlink the Gruvbox extension into ~/.vscode/extensions so VS Code picks it
# up automatically. Select "pi-env Gruvbox Dark" in the Color Theme picker.

echo ""
echo "VS Code theme"
echo "-------------"
VSCODE_EXT_DIR="$HOME/.vscode/extensions"
mkdir -p "$VSCODE_EXT_DIR"
link_path "$REPO/vscode/pi-env-gruvbox" "$VSCODE_EXT_DIR/pi-env-gruvbox" "~/.vscode/extensions/pi-env-gruvbox"

# ── Git hooks ────────────────────────────────────────────────────────────────
# Install post-merge hook so setup auto-runs after git pull

echo ""
echo "Git hooks"
echo "---------"
HOOK_SRC="$REPO/setup/post-merge"
HOOK_DST="$REPO/.git/hooks/post-merge"
if [ -L "$HOOK_DST" ] && [ "$(readlink "$HOOK_DST")" = "$HOOK_SRC" ]; then
  ok "post-merge hook"
elif [ -e "$HOOK_DST" ] && [ ! -L "$HOOK_DST" ]; then
  skip "post-merge hook (custom hook already exists at .git/hooks/post-merge)"
else
  ln -sfn "$HOOK_SRC" "$HOOK_DST"
  chmod +x "$HOOK_SRC"
  linked "post-merge hook → setup/post-merge"
fi

# ── Pi binary ────────────────────────────────────────────────────────────────
# Compile pi from the repo-local node_modules into ~/.local/bin/pi

echo ""
"$REPO/setup/install-bun-pi.sh"

echo ""
echo "Done."
echo "  Machine config: ~/.pi/agent/{auth.json,settings.json}"
echo "  Tests:          cd $REPO && bun test"
