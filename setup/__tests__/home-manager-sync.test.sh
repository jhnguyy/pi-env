#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

configure_home_manager() {
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
  PATH="$STUB_DIR:$PATH" \
  run_node "$ROOT/setup/configure.mjs" home-manager "$(node_bin)"
}

write_lock() {
  local dir="$1" rev="$2"
  mkdir -p "$dir"
  printf '{"nodes":{"root":{"inputs":{"pi-env":"pi-env"}},"pi-env":{"locked":{"rev":"%s"}}},"root":"root","version":7}\n' "$rev" > "$dir/flake.lock"
}

commit() {
  git -C "$1" -c commit.gpgsign=false commit -q --allow-empty -m "$2"
}

# Sets TMP, REPO_DIR, FLAKE_DIR, STUB_DIR, and LOG. main tracks origin/main at HEAD.
setup_fixture() {
  TMP="$(with_temp_dir)"
  REPO_DIR="$TMP/repo"
  FLAKE_DIR="$TMP/home-manager"
  STUB_DIR="$TMP/bin"
  LOG="$TMP/calls.log"
  mkdir -p "$REPO_DIR" "$STUB_DIR"
  : > "$LOG"
  git -C "$REPO_DIR" init -q -b main
  git -C "$REPO_DIR" config user.email test@example.invalid
  git -C "$REPO_DIR" config user.name 'pi-env test'
  commit "$REPO_DIR" init
  git -C "$REPO_DIR" remote add origin https://example.invalid/pi-env.git
  git -C "$REPO_DIR" update-ref refs/remotes/origin/main HEAD
  git -C "$REPO_DIR" branch -q --set-upstream-to=origin/main main
  make_executable "$STUB_DIR/nix" '#!/bin/sh
echo "nix $*" >> "$PI_ENV_TEST_LOG"
[ "$1 $2" = "flake update" ] || exit 0
printf "{\"nodes\":{\"root\":{\"inputs\":{\"pi-env\":\"pi-env\"}},\"pi-env\":{\"locked\":{\"rev\":\"%s\"}}},\"root\":\"root\",\"version\":7}\n" "$PI_ENV_TEST_UPDATED_REV" > "$5/flake.lock"'
  make_executable "$STUB_DIR/home-manager" '#!/bin/sh
echo "home-manager $*" >> "$PI_ENV_TEST_LOG"'
  export PI_ENV_TEST_LOG="$LOG"
  export PI_ENV_HOME_MANAGER_FLAKE="$FLAKE_DIR"
  unset PI_ENV_HOME_MANAGER_INPUT PI_ENV_SKIP_HOME_MANAGER PI_ENV_HOME_MANAGER_SYNC PI_ENV_TEST_UPDATED_REV || true
}

teardown_fixture() {
  unset PI_ENV_TEST_LOG PI_ENV_HOME_MANAGER_FLAKE PI_ENV_SKIP_HOME_MANAGER PI_ENV_HOME_MANAGER_SYNC PI_ENV_TEST_UPDATED_REV || true
  rm -rf "$TMP"
}

head_rev() {
  git -C "$1" rev-parse HEAD
}

assert_no_calls() {
  assert_eq "$(cat "$LOG")" "" "$1"
}

test_stale_lock_reports_without_sync_request() {
  local output
  setup_fixture
  write_lock "$FLAKE_DIR" 0000000000000000000000000000000000000000

  output="$(configure_home_manager "$REPO_DIR" "$TMP/home")"

  assert_no_calls "setup without --sync-home-manager should not update or switch"
  printf '%s' "$output" | grep -qF "input is 0000000, main is $(head_rev "$REPO_DIR" | cut -c1-7); run ./setup.sh --sync-home-manager" || fail "stale lock should be reported (got: $output)"
  grep -qF 0000000000000000000000000000000000000000 "$FLAKE_DIR/flake.lock" || fail "lock revision should not change"
  teardown_fixture
}

test_sync_request_updates_and_switches() {
  local output
  setup_fixture
  write_lock "$FLAKE_DIR" 0000000000000000000000000000000000000000
  export PI_ENV_HOME_MANAGER_SYNC=1
  export PI_ENV_TEST_UPDATED_REV
  PI_ENV_TEST_UPDATED_REV="$(head_rev "$REPO_DIR")"

  output="$(configure_home_manager "$REPO_DIR" "$TMP/home")"

  assert_eq "$(cat "$LOG")" "nix flake update pi-env --flake $FLAKE_DIR
home-manager switch --flake $FLAKE_DIR" "update and switch calls"
  printf '%s' "$output" | grep -qF 'home-manager switched with pi-env' || fail "sync should report the switch"
  teardown_fixture
}

test_matching_lock_is_noop() {
  local output
  setup_fixture
  write_lock "$FLAKE_DIR" "$(head_rev "$REPO_DIR")"

  output="$(configure_home_manager "$REPO_DIR" "$TMP/home")"

  assert_no_calls "matching lock should not update or switch"
  printf '%s' "$output" | grep -qF 'home-manager pi-env input matches main' || fail "matching lock should be reported"
  teardown_fixture
}

test_skip_conditions() {
  local output
  setup_fixture
  write_lock "$FLAKE_DIR" 0000000000000000000000000000000000000000

  output="$(PI_ENV_HOME_MANAGER_FLAKE='' configure_home_manager "$REPO_DIR" "$TMP/home")"
  printf '%s' "$output" | grep -qF 'pi-env.homeManager.sync.enable is not set' || fail "unset flake should skip"

  output="$(PI_ENV_SKIP_HOME_MANAGER=1 configure_home_manager "$REPO_DIR" "$TMP/home")"
  printf '%s' "$output" | grep -qF 'disabled by setup option' || fail "--no-home-manager should skip"

  git -C "$REPO_DIR" switch -q -c feature/test
  output="$(configure_home_manager "$REPO_DIR" "$TMP/home")"
  printf '%s' "$output" | grep -qF 'checkout is on feature/test, not main' || fail "non-main branch should skip"
  git -C "$REPO_DIR" switch -q main

  git -C "$REPO_DIR" worktree add -q "$TMP/worktree" -b feature/worktree
  output="$(configure_home_manager "$TMP/worktree" "$TMP/home")"
  printf '%s' "$output" | grep -qF 'worktree checkout' || fail "worktree should skip"
  git -C "$REPO_DIR" worktree remove -f "$TMP/worktree"

  commit "$REPO_DIR" unpushed
  output="$(PI_ENV_HOME_MANAGER_SYNC=1 configure_home_manager "$REPO_DIR" "$TMP/home")"
  printf '%s' "$output" | grep -qF 'differs from its upstream' || fail "unpushed main should skip"

  assert_no_calls "skipped sync should not update or switch"
  teardown_fixture
}

test_update_mismatch_fails_before_switch() {
  local status=0 output
  setup_fixture
  write_lock "$FLAKE_DIR" 0000000000000000000000000000000000000000
  export PI_ENV_HOME_MANAGER_SYNC=1
  export PI_ENV_TEST_UPDATED_REV=1111111111111111111111111111111111111111

  output="$(configure_home_manager "$REPO_DIR" "$TMP/home" 2>&1)" || status=$?

  [ "$status" -ne 0 ] || fail "lock mismatch after update should fail"
  printf '%s' "$output" | grep -qF 'locked 1111111 after update' || fail "mismatch should name the locked revision (got: $output)"
  assert_eq "$(cat "$LOG")" "nix flake update pi-env --flake $FLAKE_DIR" "mismatch should not switch"
  teardown_fixture
}

test_stale_lock_reports_without_sync_request
test_sync_request_updates_and_switches
test_matching_lock_is_noop
test_skip_conditions
test_update_mismatch_fails_before_switch

echo "home-manager sync tests passed"
