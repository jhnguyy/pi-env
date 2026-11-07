#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

configure_repo_tools_env() {
  run_configure repo-tools "$1" "$2"
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

test_sets_hooks_path() {
  local tmp repo
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  new_repo "$repo"

  configure_repo_tools_env "$repo" "$tmp/home" >/dev/null

  assert_eq "$(hooks_path "$repo")" "setup/hooks" "core.hooksPath"

}

test_custom_hook_keeps_hooks_path_unset() {
  local tmp repo
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  new_repo "$repo"
  printf '%s\n' '#!/usr/bin/env sh' 'echo custom' > "$repo/.git/hooks/pre-commit"

  configure_repo_tools_env "$repo" "$tmp/home" >/dev/null
  assert_eq "$(hooks_path "$repo")" "" "core.hooksPath with custom hook"
  grep -qF 'echo custom' "$repo/.git/hooks/pre-commit" || fail "custom pre-commit should not be changed"

}

test_existing_hooks_path_is_not_replaced() {
  local tmp repo
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  new_repo "$repo"
  git -C "$repo" config --local core.hooksPath .githooks

  configure_repo_tools_env "$repo" "$tmp/home" >/dev/null
  assert_eq "$(hooks_path "$repo")" ".githooks" "existing core.hooksPath"

}

test_global_hooks_path_is_not_overridden() {
  local tmp repo
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  new_repo "$repo"
  printf '[core]\n\thooksPath = /home/user/.githooks\n' > "$tmp/global.gitconfig"

  GIT_CONFIG_GLOBAL="$tmp/global.gitconfig" configure_repo_tools_env "$repo" "$tmp/home" >/dev/null
  assert_eq "$(hooks_path "$repo")" "" 'global core.hooksPath must not be overridden locally'
}

# Exercise Git's hook lookup, not only the configuration.
# A stub Nub isolates hook dispatch from the verification portfolio, which CI runs.
test_git_runs_hooks_in_primary_and_linked_worktrees() {
  local tmp repo linked output status before
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  linked="$tmp/linked"
  new_repo "$repo"
  mkdir -p "$repo/setup/hooks" "$repo/setup/__tests__" "$repo/scripts" "$tmp/bin"
  cp "$ROOT/setup/hooks/pre-commit" "$ROOT/setup/hooks/post-merge" "$repo/setup/hooks/"
  printf '#!/usr/bin/env bash\n' > "$repo/setup/check.sh"
  printf '#!/usr/bin/env bash\n' > "$repo/setup/__tests__/check.sh"
  printf '#!/usr/bin/env bash\n' > "$repo/scripts/check.sh"
  # Git passes hook stderr through, so the stub reports its call there.
  make_executable "$tmp/bin/nub" '#!/bin/sh
echo "call: $PWD: nub $*" >&2
exit "${NUB_STATUS:-0}"'
  git -C "$repo" add .
  configure_repo_tools_env "$repo" "$tmp/home" >/dev/null

  output=$(PATH="$tmp/bin:$PATH" \
    git -C "$repo" -c user.name=HookTest -c user.email=hook@example.invalid \
    commit -qm initial 2>&1) || fail "primary commit failed: $output"
  grep -qxF "call: $repo: nub run verify --checks-only" <<<"$output" || fail "primary hook did not run checks (got: $output)"

  git -C "$repo" worktree add -q -b test-linked "$linked"
  printf 'linked\n' > "$linked/linked.txt"
  git -C "$linked" add linked.txt
  before=$(git -C "$linked" rev-parse HEAD)
  status=0
  output=$(PATH="$tmp/bin:$PATH" NUB_STATUS=37 \
    git -C "$linked" -c user.name=HookTest -c user.email=hook@example.invalid \
    commit -qm linked 2>&1) || status=$?
  [ "$status" -ne 0 ] || fail 'linked worktree hook failure did not block commit'
  assert_eq "$(git -C "$linked" rev-parse HEAD)" "$before" 'linked worktree HEAD unchanged'
  grep -qxF "call: $linked: nub run verify --checks-only" <<<"$output" || fail "linked hook did not run its own checks (got: $output)"
}

test_sets_hooks_path
test_custom_hook_keeps_hooks_path_unset
test_existing_hooks_path_is_not_replaced
test_global_hooks_path_is_not_overridden
test_git_runs_hooks_in_primary_and_linked_worktrees

echo "repo hook tests passed"
