#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

configure_repo_tools_env() {
  local repo="$1" home="$2"
  REPO="$repo" \
  SETUP_DIR="$ROOT/setup" \
  SETTINGS_FILE="$home/settings.json" \
  MANAGED_SETTINGS_FILE="$ROOT/setup/config/managed-settings.json" \
  AGENTS_DIR="$home/.agents" \
  TEST_UTILS_DIR="$home/.pi/agent/extensions/__tests__" \
  APPEND_SRC="$ROOT/.pi/agent/APPEND_SYSTEM.md" \
  APPEND_DST="$home/.pi/agent/APPEND_SYSTEM.md" \
  APPEND_MARKER="<!-- test -->" \
  PI_AGENT_DIR="$home/.pi/agent" \
  TMUX_CONF="$home/.tmux.conf" \
  TMUX_SOURCE_LINE="source-file $ROOT/setup/templates/tmux.conf" \
  GHOSTTY_CONFIG_DIR="$home/.config/ghostty" \
  POST_MERGE_HOOK_SRC="$ROOT/setup/hooks/post-merge" \
  PRE_COMMIT_HOOK_SRC="$ROOT/setup/hooks/pre-commit" \
  run_node "$ROOT/setup/configure.mjs" repo-tools "$(node_bin)"
}

new_repo() {
  local repo="$1"
  mkdir -p "$repo"
  git -C "$repo" init -q
  mkdir -p "$repo/.git/hooks"
}

hooks_path() {
  git -C "$1" config --local --get core.hooksPath || true
}

test_sets_hooks_path_and_removes_legacy_links() {
  local tmp repo output
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  new_repo "$repo"
  ln -s "$ROOT/setup/hooks/post-merge" "$repo/.git/hooks/post-merge"
  ln -s "$ROOT/setup/hooks/pre-commit" "$repo/.git/hooks/pre-commit"

  configure_repo_tools_env "$repo" "$tmp/home" >/dev/null

  assert_eq "$(hooks_path "$repo")" "setup/hooks" "core.hooksPath"
  [ ! -e "$repo/.git/hooks/post-merge" ] && [ ! -L "$repo/.git/hooks/post-merge" ] || fail "legacy post-merge link should be removed"
  [ ! -e "$repo/.git/hooks/pre-commit" ] && [ ! -L "$repo/.git/hooks/pre-commit" ] || fail "legacy pre-commit link should be removed"

  output="$(configure_repo_tools_env "$repo" "$tmp/home")"
  printf '%s' "$output" | grep -qF 'repo hooks (core.hooksPath=setup/hooks)' || fail "second run should report configured hooks"

  rm -rf "$tmp"
}

test_custom_hook_keeps_hooks_path_unset() {
  local tmp repo output
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env sh' 'echo custom' > "$repo/.git/hooks/pre-commit"

  output="$(configure_repo_tools_env "$repo" "$tmp/home")"

  printf '%s' "$output" | grep -qF 'custom hooks exist in .git/hooks: pre-commit' || fail "custom hook should skip hook install"
  assert_eq "$(hooks_path "$repo")" "" "core.hooksPath with custom hook"
  grep -qF 'echo custom' "$repo/.git/hooks/pre-commit" || fail "custom pre-commit should not be changed"

  rm -rf "$tmp"
}

test_existing_hooks_path_is_not_replaced() {
  local tmp repo output
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  new_repo "$repo"
  git -C "$repo" config --local core.hooksPath .githooks

  output="$(configure_repo_tools_env "$repo" "$tmp/home")"

  printf '%s' "$output" | grep -qF 'core.hooksPath already set to .githooks' || fail "existing hooksPath should be reported"
  assert_eq "$(hooks_path "$repo")" ".githooks" "existing core.hooksPath"

  rm -rf "$tmp"
}

# core.hooksPath runs the tracked files directly, so Git must store them as executable.
test_tracked_hooks_are_executable() {
  local hook mode
  git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
  for hook in "$ROOT"/setup/hooks/*; do
    mode=$(git -C "$ROOT" ls-files -s -- "setup/hooks/$(basename "$hook")" | cut -d' ' -f1)
    assert_eq "$mode" "100755" "git mode of setup/hooks/$(basename "$hook")"
  done
}

test_sets_hooks_path_and_removes_legacy_links
test_custom_hook_keeps_hooks_path_unset
test_existing_hooks_path_is_not_replaced
test_tracked_hooks_are_executable

echo "repo hook tests passed"
