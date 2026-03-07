#!/usr/bin/env bash
# pi-env dotfiles setup
#
# Idempotent. Re-run after git pull to pick up new extensions/skills.
#
# What it does:
#   ~/.agents/skills/<name>              → repo/.agents/skills/<name>  (per-skill, skips local dirs)
#   ~/.pi/agent/extensions/<name>        → repo/.pi/extensions/<name>  (per-extension, skips local dirs)
#   ~/.pi/agent/AGENTS.md               → repo/AGENTS.md              (skips if local file exists)
#
# What stays local (never touched):
#   ~/.pi/agent/auth.json, settings.json, models.json, sessions/
#   ~/.pi/agent/extensions/my-extension/ (or any other local extension)
#   ~/.agents/skills/my-skill/ (or any other local skill)

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

# ── Skills (per-skill, mirrors extension pattern) ────────────────────────────

echo "Skills"
echo "------"
mkdir -p "$AGENTS_DIR/skills"
for skill in "$REPO/.agents/skills/"/*/; do
  [ -d "$skill" ] || continue
  name="$(basename "${skill%/}")"
  [[ "$name" == "reference" ]] && continue  # linked as a directory below
  link_path "${skill%/}" "$AGENTS_DIR/skills/$name" "~/.agents/skills/$name"
done

# Reference skills linked as a directory (manually loaded, not auto-discovered)
link_path "$REPO/.agents/skills/reference" "$AGENTS_DIR/skills/reference" "~/.agents/skills/reference"

# ── Extensions (per-extension) ───────────────────────────────────────────────

echo ""
echo "Extensions"
echo "----------"
mkdir -p "$PI_AGENT_DIR/extensions"
for ext in "$REPO/.pi/extensions/"/*/; do
  [ -d "$ext" ] || continue
  name="$(basename "${ext%/}")"
  [[ "$name" == __tests__ || "$name" == node_modules || "$name" == docs ]] && continue
  link_path "${ext%/}" "$PI_AGENT_DIR/extensions/$name" "~/.pi/agent/extensions/$name"
done

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

# ── AGENTS.md ────────────────────────────────────────────────────────────────

echo ""
echo "AGENTS.md"
echo "---------"
link_path "$REPO/AGENTS.md" "$PI_AGENT_DIR/AGENTS.md" "~/.pi/agent/AGENTS.md"

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
# Compile pi from the repo-local node_modules into ~/.pi/bin/pi

echo ""
"$REPO/setup/install-bun-pi.sh"

echo ""
echo "Done."
echo "  Machine config: ~/.pi/agent/{auth.json,settings.json}"
echo "  Tests:          cd $REPO && bun test"
