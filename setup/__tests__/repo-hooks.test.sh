#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_env() {
  local repo="$1" home="$2"
  export REPO="$repo"
  export SETUP_DIR="$ROOT/setup"
  export SETTINGS_FILE="$home/settings.json"
  export MANAGED_SETTINGS_FILE="$ROOT/setup/managed-settings.json"
  export AGENTS_DIR="$home/.agents"
  export TEST_UTILS_DIR="$home/.pi/agent/extensions/__tests__"
  export APPEND_SRC="$ROOT/.pi/agent/APPEND_SYSTEM.md"
  export APPEND_DST="$home/.pi/agent/APPEND_SYSTEM.md"
  export APPEND_MARKER="<!-- test -->"
  export PI_AGENT_DIR="$home/.pi/agent"
  export TMUX_CONF="$home/.tmux.conf"
  export TMUX_SOURCE_LINE="source-file $ROOT/setup/tmux.conf"
  export GHOSTTY_CONFIG_DIR="$home/.config/ghostty"
  export POST_MERGE_HOOK_SRC="$ROOT/setup/post-merge"
  export PRE_COMMIT_HOOK_SRC="$ROOT/setup/pre-commit"
}

test_regular_existing_hook_is_skipped_not_fatal() {
  local tmp repo output
  tmp="$(mktemp -d)"
  repo="$tmp/repo"
  mkdir -p "$repo"
  git -C "$repo" init -q
  mkdir -p "$repo/.git/hooks"
  printf '%s\n' '#!/usr/bin/env sh' 'echo custom' > "$repo/.git/hooks/pre-commit"

  make_env "$repo" "$tmp/home"
  output="$($ROOT/scripts/node-run.sh "$ROOT/setup/configure.mjs" repo-tools /bin/node)"

  printf '%s' "$output" | grep -q 'pre-commit hook (custom hook already exists' || fail "regular custom hook should be skipped"
  [ -L "$repo/.git/hooks/post-merge" ] || fail "post-merge should be linked"
  [ ! -L "$repo/.git/hooks/pre-commit" ] || fail "custom pre-commit should not be replaced"

  rm -rf "$tmp"
}

test_regular_existing_hook_is_skipped_not_fatal

echo "repo hook tests passed"
