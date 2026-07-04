#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

configure_repo_tools_env() {
  local repo="$1" home="$2"
  REPO="$repo" \
  SETUP_DIR="$ROOT/setup" \
  SETTINGS_FILE="$home/settings.json" \
  MANAGED_SETTINGS_FILE="$ROOT/setup/managed-settings.json" \
  AGENTS_DIR="$home/.agents" \
  TEST_UTILS_DIR="$home/.pi/agent/extensions/__tests__" \
  APPEND_SRC="$ROOT/.pi/agent/APPEND_SYSTEM.md" \
  APPEND_DST="$home/.pi/agent/APPEND_SYSTEM.md" \
  APPEND_MARKER="<!-- test -->" \
  PI_AGENT_DIR="$home/.pi/agent" \
  TMUX_CONF="$home/.tmux.conf" \
  TMUX_SOURCE_LINE="source-file $ROOT/setup/tmux.conf" \
  GHOSTTY_CONFIG_DIR="$home/.config/ghostty" \
  POST_MERGE_HOOK_SRC="$ROOT/setup/post-merge" \
  PRE_COMMIT_HOOK_SRC="$ROOT/setup/pre-commit" \
  run_node "$ROOT/setup/configure.mjs" repo-tools "$(node_bin)"
}

test_regular_existing_hook_is_skipped_not_fatal() {
  local tmp repo output
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  mkdir -p "$repo/.git/hooks"
  printf '%s\n' '#!/usr/bin/env sh' 'echo custom' > "$repo/.git/hooks/pre-commit"

  output="$(configure_repo_tools_env "$repo" "$tmp/home")"

  printf '%s' "$output" | grep -q 'pre-commit hook (custom hook already exists' || fail "regular custom hook should be skipped"
  [ -L "$repo/.git/hooks/post-merge" ] || fail "post-merge should be linked"
  [ ! -L "$repo/.git/hooks/pre-commit" ] || fail "custom pre-commit should not be replaced"

  rm -rf "$tmp"
}

test_regular_existing_hook_is_skipped_not_fatal

echo "repo hook tests passed"
