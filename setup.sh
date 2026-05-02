#!/usr/bin/env bash
# pi-env dotfiles setup
#
# Idempotent. Re-run after git pull to pick up new extensions/skills.
#
# What it does:
#   1. bun install (frozen lockfile; postinstall builds extensions)
#   2. Install pi CLI with Bun into a user-local prefix + ~/.local/bin/pi
#   3. Bootstrap settings.json from template (only on first run — never overwrites)
#   4. Register pi-env as a pi package in settings.json
#   5. Set gruvbox as the pi theme in settings.json
#   6. Bootstrap APPEND_SYSTEM.md → ~/.pi/agent/APPEND_SYSTEM.md
#   7. Bootstrap AGENTS.md → ~/.pi/agent/AGENTS.md
#   8. Symlink roles → ~/.agents/roles
#   9. Source tmux theme from ~/.tmux.conf
#  10. Symlink VS Code Gruvbox extension → ~/.vscode/extensions/
#  11. Install git post-merge hook
#
# Extensions and skills are loaded by pi's package manager from the repo
# directory — no per-extension or per-skill symlinks needed. Local extensions
# in ~/.pi/agent/extensions/ coexist via pi's auto-discovery.
#
# What stays local (never touched after first run):
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
# bun.lock and postinstall builds extension bundles. The Pi CLI install below
# uses Bun's package manager too, but into a separate user-local prefix.

echo "Dependencies"
echo "------------"
(cd "$REPO" && bun install --frozen-lockfile)
ok "node_modules up to date"

# ── Pi CLI ──────────────────────────────────────────────────────────────────
# Install the CLI with Bun into an isolated user-local prefix, then expose a
# stable ~/.local/bin/pi command. The wrapper intentionally runs Pi's Bun
# entrypoint so machines do not need a separate Node install just to launch pi.

echo ""
echo "Pi CLI"
echo "------"
PI_VERSION=$(cd "$REPO" && bun -e "const pkg = await import('./package.json', { with: { type: 'json' } }); console.log(pkg.default.devDependencies['@mariozechner/pi-coding-agent'] ?? pkg.default.dependencies?.['@mariozechner/pi-coding-agent']);" 2>/dev/null)
PI_CLI_ROOT="${PI_CLI_ROOT:-$HOME/.local/share/pi-env/pi-cli}"
PI_BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"
PI_PKG_SPEC="@mariozechner/pi-coding-agent@$PI_VERSION"
mkdir -p "$PI_BIN_DIR" "$PI_CLI_ROOT"
BUN_INSTALL="$PI_CLI_ROOT" bun install -g "$PI_PKG_SPEC"
PI_PACKAGE_DIR="$PI_CLI_ROOT/install/global/node_modules/@mariozechner/pi-coding-agent"
PI_ENTRY="$PI_PACKAGE_DIR/dist/bun/cli.js"
[ -f "$PI_PACKAGE_DIR/package.json" ] || { echo "  ✗  missing pi package after install: $PI_PACKAGE_DIR" >&2; exit 1; }
[ -f "$PI_ENTRY" ] || { echo "  ✗  missing pi entrypoint after install: $PI_ENTRY" >&2; exit 1; }
PI_CLI_ROOT_LITERAL=$(printf '%s' "$PI_CLI_ROOT" | sed "s/'/'\\\\''/g")
cat > "$PI_BIN_DIR/pi" <<EOF
#!/usr/bin/env sh
set -eu

DEFAULT_PI_CLI_ROOT='$PI_CLI_ROOT_LITERAL'
PI_CLI_ROOT="\${PI_CLI_ROOT:-\$DEFAULT_PI_CLI_ROOT}"
PI_PACKAGE_DIR="\$PI_CLI_ROOT/install/global/node_modules/@mariozechner/pi-coding-agent"
PI_ENTRY="\$PI_PACKAGE_DIR/dist/bun/cli.js"

if [ ! -f "\$PI_PACKAGE_DIR/package.json" ] || [ ! -f "\$PI_ENTRY" ]; then
  echo "pi-env: missing pi package install at \$PI_PACKAGE_DIR" >&2
  echo "pi-env: rerun setup.sh, or set PI_CLI_ROOT to the install prefix." >&2
  exit 127
fi

exec bun "\$PI_ENTRY" "\$@"
EOF
chmod +x "$PI_BIN_DIR/pi"
ok "pi $PI_VERSION → $PI_BIN_DIR/pi"
if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$PI_BIN_DIR"; then
  echo "  —  $PI_BIN_DIR is not in PATH yet; add it to your shell profile."
fi

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

# ── Settings bootstrap ───────────────────────────────────────────────────────
# Auto-create settings.json from the template when it doesn't exist yet.
# This makes setup.sh fully one-shot on fresh machines and devcontainers —
# no need to manually copy the template and re-run.
#
# If settings.json already exists (local customizations, auth tokens, etc.)
# it is never overwritten. The template is only used as a bootstrap.

echo ""
echo "Settings"
echo "--------"
SETTINGS_FILE="$PI_AGENT_DIR/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  mkdir -p "$PI_AGENT_DIR"
  cp "$REPO/setup/settings.template.json" "$SETTINGS_FILE"
  linked "settings.json ← settings.template.json (review and customize: defaultModel, permissionLevel)"
else
  ok "settings.json (exists — not overwritten)"
fi

# ── Package registration ────────────────────────────────────────────────────
# Register pi-env as a local pi package so pi's package manager discovers
# extensions and skills directly from the repo. No per-item symlinks needed.

echo ""
echo "Package registration"
echo "--------------------"
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
fi

# ── Pi theme ─────────────────────────────────────────────────────────────────
# Set the gruvbox theme in settings.json so pi uses it on first launch.
# gruvbox.json ships in this repo's themes/ directory and is loaded by pi
# via the registered package — requires package registration above to complete.

echo ""
echo "Pi theme"
echo "--------"
if bun -e "
  const s = JSON.parse(require('fs').readFileSync('$SETTINGS_FILE', 'utf-8'));
  process.exit(s.theme === 'gruvbox' ? 0 : 1);
" 2>/dev/null; then
  ok "theme set to gruvbox in settings.json"
else
  bun -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf-8'));
    s.theme = 'gruvbox';
    fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(s, null, 2) + '\n');
  " 2>/dev/null
  linked "theme → gruvbox in settings.json"
fi

# ── Roles (entire directory, no local override) ──────────────────────────────
# Roles are a pi-env concept (not a pi primitive), so they still need symlinking.

echo ""
echo "Roles"
echo "-----"
mkdir -p "$AGENTS_DIR"
link_path "$REPO/.agents/roles" "$AGENTS_DIR/roles" "~/.agents/roles"

# ── APPEND_SYSTEM.md ────────────────────────────────────────────────────────
# ~/.pi/agent/APPEND_SYSTEM.md appends to the system prompt on every session.
# The local file may have user-managed content. Setup appends the repo block
# idempotently — skips if the marker is already present.

echo ""
echo "APPEND_SYSTEM.md"
echo "----------------"
APPEND_SRC="$REPO/.pi/agent/APPEND_SYSTEM.md"
APPEND_DST="$PI_AGENT_DIR/APPEND_SYSTEM.md"
MARKER="<!-- pi-env:append-system -->"
if [ ! -e "$APPEND_DST" ]; then
  printf '%s\n' "$MARKER" > "$APPEND_DST"
  cat "$APPEND_SRC" >> "$APPEND_DST"
  ok "~/.pi/agent/APPEND_SYSTEM.md (created with repo block)"
elif grep -qF "$MARKER" "$APPEND_DST"; then
  ok "~/.pi/agent/APPEND_SYSTEM.md (repo block already present)"
else
  printf '\n%s\n' "$MARKER" >> "$APPEND_DST"
  cat "$APPEND_SRC" >> "$APPEND_DST"
  ok "~/.pi/agent/APPEND_SYSTEM.md (appended repo block)"
fi

# ── AGENTS.md ────────────────────────────────────────────────────────────────
# ~/.pi/agent/AGENTS.md is managed independently — global behavioral rules
# that apply across all repos, not just pi-env. Not symlinked here.
# pi-env/AGENTS.md loads as project context when cwd is the pi-env repo.

echo ""
echo "AGENTS.md"
echo "---------"
if [ -e "$PI_AGENT_DIR/AGENTS.md" ]; then
  ok "~/.pi/agent/AGENTS.md (exists — not overwritten)"
else
  cp "$REPO/AGENTS.md" "$PI_AGENT_DIR/AGENTS.md"
  ok "~/.pi/agent/AGENTS.md (bootstrapped from repo — customize for your environment)"
fi

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
echo "Tmux"
echo "----"
TMUX_THEME_SRC="$REPO/setup/tmux.conf"
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
if mkdir -p "$VSCODE_EXT_DIR" 2>/dev/null; then
  link_path "$REPO/vscode/pi-env-gruvbox" "$VSCODE_EXT_DIR/pi-env-gruvbox" "~/.vscode/extensions/pi-env-gruvbox"
else
  skip "~/.vscode/extensions/pi-env-gruvbox (cannot create $VSCODE_EXT_DIR)"
fi

# ── Git hooks ────────────────────────────────────────────────────────────────
# Install post-merge hook so setup auto-runs after git pull

echo ""
echo "Git hooks"
echo "---------"
HOOK_SRC="$REPO/setup/post-merge"
GIT_DIR="$(git -C "$REPO" rev-parse --absolute-git-dir)"
GIT_COMMON_DIR="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)"
if [ "$GIT_DIR" != "$GIT_COMMON_DIR" ]; then
  skip "post-merge hook (worktree checkout — run setup.sh in the primary checkout to update shared hooks)"
else
  HOOK_DST="$GIT_COMMON_DIR/hooks/post-merge"
  mkdir -p "$(dirname "$HOOK_DST")"
  if [ -L "$HOOK_DST" ] && [ "$(readlink "$HOOK_DST")" = "$HOOK_SRC" ]; then
    ok "post-merge hook"
  elif [ -e "$HOOK_DST" ] && [ ! -L "$HOOK_DST" ]; then
    skip "post-merge hook (custom hook already exists at .git/hooks/post-merge)"
  else
    ln -sfn "$HOOK_SRC" "$HOOK_DST"
    chmod +x "$HOOK_SRC"
    linked "post-merge hook → setup/post-merge"
  fi
fi

echo ""
echo "Done."
echo "  Pi CLI:         $PI_BIN_DIR/pi"
echo "  Machine config: ~/.pi/agent/{auth.json,settings.json}"
echo "  Tests:          cd $REPO && bun test"
