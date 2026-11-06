#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

STALE=0000000000000000000000000000000000000000

write_lock() {
  mkdir -p "$1"
  printf '{"nodes":{"root":{"inputs":{"pi-env":"pi-env"}},"pi-env":{"locked":{"rev":"%s"}}},"root":"root","version":7}\n' "$2" > "$1/flake.lock"
}

commit() {
  git -C "$1" -c commit.gpgsign=false commit -q --allow-empty -m "$2"
}

head_rev() {
  git -C "$REPO_DIR" rev-parse HEAD
}

# Stubs report calls on stderr; keep only those lines from captured output.
calls() {
  sed -n 's/^call: //p' <<<"$1"
}

# Sets TMP, REPO_DIR, FLAKE_DIR, and STUB_DIR. Local main matches its upstream.
setup_fixture() {
  TMP="$(with_temp_dir)"
  REPO_DIR="$TMP/repo"
  FLAKE_DIR="$TMP/home-manager"
  STUB_DIR="$TMP/bin"
  mkdir -p "$REPO_DIR" "$STUB_DIR"
  git -C "$REPO_DIR" init -q -b main
  git -C "$REPO_DIR" config user.email test@example.invalid
  git -C "$REPO_DIR" config user.name 'pi-env test'
  commit "$REPO_DIR" init
  git -C "$REPO_DIR" remote add origin https://example.invalid/pi-env.git
  git -C "$REPO_DIR" update-ref refs/remotes/origin/main HEAD
  git -C "$REPO_DIR" branch -q --set-upstream-to=origin/main main
  write_lock "$FLAKE_DIR" "$STALE"
  # flake update writes PI_ENV_TEST_UPDATED_REV, so a test can simulate an update that misses main.
  make_executable "$STUB_DIR/nix" '#!/bin/sh
echo "call: nix $*" >&2
[ "$1 $2" = "flake update" ] || exit 0
printf "{\"nodes\":{\"root\":{\"inputs\":{\"pi-env\":\"pi-env\"}},\"pi-env\":{\"locked\":{\"rev\":\"%s\"}}},\"root\":\"root\",\"version\":7}\n" "$PI_ENV_TEST_UPDATED_REV" > "$5/flake.lock"'
  make_executable "$STUB_DIR/home-manager" '#!/bin/sh
echo "call: home-manager $*" >&2'
  export PI_ENV_HOME_MANAGER_FLAKE="$FLAKE_DIR"
  export PI_ENV_TEST_UPDATED_REV
  PI_ENV_TEST_UPDATED_REV="$(head_rev)"
  unset PI_ENV_HOME_MANAGER_INPUT PI_ENV_SKIP_HOME_MANAGER PI_ENV_HOME_MANAGER_SYNC || true
}

teardown_fixture() {
  unset PI_ENV_HOME_MANAGER_FLAKE PI_ENV_TEST_UPDATED_REV \
    PI_ENV_SKIP_HOME_MANAGER PI_ENV_HOME_MANAGER_SYNC || true
}

configure_home_manager() {
  PATH="$STUB_DIR:$PATH" run_configure home-manager "${1:-$REPO_DIR}" "$TMP/home" 2>&1
}

test_drift_is_reported_without_sync_request() {
  local output
  setup_fixture

  output="$(configure_home_manager)"

  assert_eq "$(calls "$output")" "" "setup without --sync-home-manager should not update or switch"
  grep -qF "input is 0000000, main is $(head_rev | cut -c1-7); run ./setup.sh --sync-home-manager" <<<"$output" ||
    fail "drift should be reported (got: $output)"
  assert_file_contains "$FLAKE_DIR/flake.lock" "$STALE"
  teardown_fixture
}

test_sync_request_updates_then_switches() {
  local output
  setup_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1

  output="$(configure_home_manager)"

  assert_eq "$(calls "$output")" "nix flake update pi-env --flake $FLAKE_DIR
home-manager switch --flake $FLAKE_DIR" "update and switch calls"
  teardown_fixture
}

test_matching_input_is_current() {
  local output
  setup_fixture
  write_lock "$FLAKE_DIR" "$(head_rev)"
  export PI_ENV_HOME_MANAGER_SYNC=1

  output="$(configure_home_manager)"

  assert_eq "$(calls "$output")" "" "matching input should not update or switch"
  grep -qF 'home-manager pi-env input matches main' <<<"$output" || fail "matching input should be reported"
  teardown_fixture
}

# Each skip protects a case where updating the input would pin something other than published main.
test_sync_skips_unpublishable_checkouts() {
  local output all=""
  setup_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1

  output="$(PI_ENV_HOME_MANAGER_FLAKE='' configure_home_manager)"
  all+=$output$'\n'
  grep -qF 'pi-env.homeManager.sync.enable is not set' <<<"$output" || fail "unset flake should skip"

  output="$(PI_ENV_SKIP_HOME_MANAGER=1 configure_home_manager)"
  all+=$output$'\n'
  grep -qF 'disabled by setup option' <<<"$output" || fail "--no-home-manager should skip"

  git -C "$REPO_DIR" switch -q -c feature/test
  output="$(configure_home_manager)"
  all+=$output$'\n'
  grep -qF 'checkout is on feature/test, not main' <<<"$output" || fail "non-main branch should skip"
  git -C "$REPO_DIR" switch -q main

  git -C "$REPO_DIR" worktree add -q "$TMP/worktree" -b feature/worktree
  output="$(configure_home_manager "$TMP/worktree")"
  all+=$output$'\n'
  grep -qF 'worktree checkout' <<<"$output" || fail "worktree should skip"
  git -C "$REPO_DIR" worktree remove -f "$TMP/worktree"

  commit "$REPO_DIR" unpushed
  output="$(configure_home_manager)"
  all+=$output$'\n'
  grep -qF 'differs from its upstream' <<<"$output" || fail "unpushed main should skip"

  assert_eq "$(calls "$all")" "" "skipped sync should not update or switch"
  teardown_fixture
}

test_update_mismatch_fails_before_switch() {
  local status=0 output
  setup_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1 PI_ENV_TEST_UPDATED_REV=1111111111111111111111111111111111111111

  output="$(configure_home_manager)" || status=$?

  [ "$status" -ne 0 ] || fail "lock mismatch after update should fail"
  grep -qF 'locked 1111111 after update' <<<"$output" || fail "mismatch should name the locked revision (got: $output)"
  assert_eq "$(calls "$output")" "nix flake update pi-env --flake $FLAKE_DIR" "mismatch should not switch"
  teardown_fixture
}

write_pi_package() {
  mkdir -p "$1/dist"
  printf '{"name":"@earendil-works/pi-coding-agent","version":"%s","bin":{"pi":"dist/cli.js"}}\n' "$2" > "$1/package.json"
  : > "$1/dist/cli.js"
}

write_generation() {
  local session="$1/home-path/etc/profile.d/hm-session-vars.sh"
  mkdir -p "$(dirname "$session")"
  printf '[ -n "$__HM_SESS_VARS_SOURCED" ] && return\nexport __HM_SESS_VARS_SOURCED=1\nexport PI_PACKAGE_DIR="%s"\n' "$2" > "$session"
}

# The checkout requires Pi 1.2.3; the caller's shell comes from an older generation with Pi 1.0.0.
setup_runtime_fixture() {
  local node
  setup_fixture
  node="$(node_bin)"
  mkdir -p "$REPO_DIR/scripts" "$REPO_DIR/node_modules/@earendil-works"
  cp "$ROOT/scripts/check-node-version.mjs" "$ROOT/scripts/node-policy.mjs" "$REPO_DIR/scripts/"
  printf '{"engines":{"node":">=%s"},"devDependencies":{"@earendil-works/pi-coding-agent":"1.2.3"}}\n' \
    "$("$node" -p 'process.versions.node')" > "$REPO_DIR/package.json"
  write_pi_package "$REPO_DIR/node_modules/@earendil-works/pi-coding-agent" 1.2.3
  write_pi_package "$TMP/pi-1.0.0" 1.0.0
  write_pi_package "$TMP/pi-1.2.3" 1.2.3
  write_generation "$TMP/generations/old" "$TMP/pi-1.0.0"
  write_generation "$TMP/generations/new" "$TMP/pi-1.2.3"
  echo "$TMP/generations/old" > "$TMP/generations/current"
  make_executable "$STUB_DIR/nub" '#!/bin/sh
exit 0'
  make_executable "$STUB_DIR/home-manager" '#!/bin/sh
case "$1" in
  switch)
    [ -z "${PI_ENV_TEST_SWITCH_STATUS:-}" ] || exit "$PI_ENV_TEST_SWITCH_STATUS"
    echo "$PI_ENV_TEST_GENERATIONS/new" > "$PI_ENV_TEST_GENERATIONS/current" ;;
  generations)
    printf "2026-01-01 00:00 : id 2 -> %s (current)\n" "$(cat "$PI_ENV_TEST_GENERATIONS/current")" ;;
esac'
  export PI_ENV_TEST_GENERATIONS="$TMP/generations" PI_ENV_HOME_MANAGER_SYNC=1
  export PI_ENV_NODE_BIN="$node" PI_ENV_CONFIG_MANAGED_BY_NIX=1
  export PI_PACKAGE_DIR="$TMP/pi-1.0.0" __HM_SESS_VARS_SOURCED=1
}

teardown_runtime_fixture() {
  unset PI_ENV_TEST_GENERATIONS PI_ENV_TEST_SWITCH_STATUS PI_ENV_NODE_BIN \
    PI_ENV_CONFIG_MANAGED_BY_NIX PI_PACKAGE_DIR __HM_SESS_VARS_SOURCED || true
  teardown_fixture
}

# Runs the real runtime stage sequence in a fresh errexit shell, as setup/main.sh does.
run_setup_runtime() {
  env PATH="$STUB_DIR:$PATH" ROOT="$ROOT" REPO="$REPO_DIR" TMP="$TMP" \
    AGENTS_DIR="$TMP/home/.agents" XDG_CONFIG_HOME="$TMP/home/.config" \
    GHOSTTY_CONFIG_DIR="$TMP/home/.config/ghostty" \
    bash -euo pipefail -c '
      source "$ROOT/setup/lib.sh"
      source "$ROOT/setup/install.sh"
      source "$ROOT/setup/configure.sh"
      SETUP_DIR="$ROOT/setup" PI_BIN_DIR="$TMP/home/.local/bin"
      PI_AGENT_DIR="$TMP/home/.pi/agent"
      setup_install_runtime'
}

adapter_package() {
  sed -n "s/^DEFAULT_PI_PACKAGE_DIR='\(.*\)'$/\1/p" "$TMP/home/.local/bin/pi" 2>/dev/null || true
}

test_sync_installs_pi_from_activated_generation() {
  local output
  setup_runtime_fixture

  output="$(run_setup_runtime 2>&1)" || fail "sync from an old shell should succeed (got: $output)"

  assert_eq "$(adapter_package)" "$TMP/pi-1.2.3" "Pi wrapper should use the activated generation's package"
  teardown_runtime_fixture
}

test_switch_failure_stops_before_pi_cli() {
  local status=0 output
  setup_runtime_fixture
  export PI_ENV_TEST_SWITCH_STATUS=1

  output="$(run_setup_runtime 2>&1)" || status=$?

  [ "$status" -ne 0 ] || fail "failed switch should fail setup"
  ! grep -qx 'Pi CLI' <<<"$output" || fail "Pi CLI stage should not run after a failed switch"
  assert_eq "$(adapter_package)" "" "failed switch should not write the Pi wrapper"
  teardown_runtime_fixture
}

test_drift_is_reported_without_sync_request
test_sync_request_updates_then_switches
test_matching_input_is_current
test_sync_skips_unpublishable_checkouts
test_update_mismatch_fails_before_switch
test_sync_installs_pi_from_activated_generation
test_switch_failure_stops_before_pi_cli

echo "home-manager sync tests passed"
