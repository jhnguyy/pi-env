#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

configure_home_manager() {
  local repo="$1" home="$2"
  REPO="$repo" \
  SETUP_DIR="$ROOT/setup" \
  SETTINGS_FILE="$home/settings.json" \
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

# Runs the real runtime stage sequence in a fresh errexit shell, as setup/main.sh does.
# Nub install is stubbed; Home Manager supplies Pi through PI_PACKAGE_DIR.
run_setup_runtime() {
  env PATH="$STUB_DIR:$PATH" ROOT="$ROOT" REPO="$REPO_DIR" TMP="$TMP" \
    bash -euo pipefail -c '
      source "$ROOT/setup/lib.sh"
      source "$ROOT/setup/install.sh"
      source "$ROOT/setup/configure.sh"
      SETUP_DIR="$ROOT/setup" PI_BIN_DIR="$TMP/home/.local/bin"
      PI_AGENT_DIR="$TMP/home/.pi/agent" AGENTS_DIR="$TMP/home/.agents"
      SETTINGS_FILE="$PI_AGENT_DIR/settings.json" TMUX_CONF="$TMP/home/.tmux.conf"
      TMUX_SOURCE_LINE=unused GHOSTTY_CONFIG_DIR="$TMP/home/ghostty" APPEND_SRC=unused
      APPEND_DST=unused APPEND_MARKER=unused TEST_UTILS_DIR=unused
      POST_MERGE_HOOK_SRC=unused PRE_COMMIT_HOOK_SRC=unused
      setup_install_runtime'
}

write_pi_package() {
  local dir="$1" version="$2"
  mkdir -p "$dir/dist"
  printf '{"name":"@earendil-works/pi-coding-agent","version":"%s","bin":{"pi":"dist/cli.js"}}\n' "$version" > "$dir/package.json"
  : > "$dir/dist/cli.js"
}

# Writes a Home Manager generation whose session variables supply the given Pi package.
write_generation() {
  local generation="$1" pi_package="$2" session
  session="$generation/home-path/etc/profile.d/hm-session-vars.sh"
  mkdir -p "$(dirname "$session")"
  printf '[ -n "$__HM_SESS_VARS_SOURCED" ] && return\nexport __HM_SESS_VARS_SOURCED=1\nexport PI_PACKAGE_DIR="%s"\n' "$pi_package" > "$session"
}

# The workbench requires Pi 1.2.3. The shell comes from an older generation that supplies
# Pi 1.0.0 and predates any variable this change introduces. Switching activates 1.2.3.
setup_pi_bump_fixture() {
  setup_fixture
  local node
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
  write_lock "$FLAKE_DIR" 0000000000000000000000000000000000000000
  make_executable "$STUB_DIR/nub" '#!/bin/sh
echo "nub $*" >> "$PI_ENV_TEST_LOG"
[ "$1" = install ] && exit "${PI_ENV_TEST_NUB_INSTALL_STATUS:-0}"
exit 0'
  make_executable "$STUB_DIR/home-manager" '#!/bin/sh
echo "home-manager $*" >> "$PI_ENV_TEST_LOG"
case "$1" in
  switch)
    [ -z "${PI_ENV_TEST_SWITCH_STATUS:-}" ] || exit "$PI_ENV_TEST_SWITCH_STATUS"
    echo "$PI_ENV_TEST_GENERATIONS/new" > "$PI_ENV_TEST_GENERATIONS/current" ;;
  generations)
    [ -z "${PI_ENV_TEST_NO_GENERATIONS:-}" ] || exit 0
    printf "2026-01-01 00:00 : id 2 -> %s (current)\n" "$(cat "$PI_ENV_TEST_GENERATIONS/current")" ;;
esac'
  export PI_ENV_TEST_GENERATIONS="$TMP/generations"
  export PI_ENV_NODE_BIN="$node" PI_ENV_CONFIG_MANAGED_BY_NIX=1
  export PI_PACKAGE_DIR="$TMP/pi-1.0.0" __HM_SESS_VARS_SOURCED=1
  export PI_ENV_TEST_UPDATED_REV
  PI_ENV_TEST_UPDATED_REV="$(head_rev "$REPO_DIR")"
}

teardown_pi_bump_fixture() {
  unset PI_ENV_NODE_BIN PI_ENV_CONFIG_MANAGED_BY_NIX PI_PACKAGE_DIR __HM_SESS_VARS_SOURCED \
    PI_ENV_TEST_GENERATIONS PI_ENV_TEST_NUB_INSTALL_STATUS PI_ENV_TEST_SWITCH_STATUS \
    PI_ENV_TEST_NO_GENERATIONS || true
  teardown_fixture
}

adapter_package() {
  sed -n "s/^DEFAULT_PI_PACKAGE_DIR='\(.*\)'$/\1/p" "$TMP/home/.local/bin/pi" 2>/dev/null || true
}

home_manager_calls() {
  grep -E '^(nix|home-manager) ' "$LOG" || true
}

stage_ran() {
  printf "%s\n" "$OUTPUT" | grep -qx "$1"
}

# Runs one scenario and retains its inputs, observations, and verdict.
# The check function reads STATUS and OUTPUT and returns 0 when the outcome is correct.
run_pi_bump_scenario() {
  local name="$1" expected="$2" check="$3" dir verdict=fail
  STATUS=0
  OUTPUT="$(run_setup_runtime 2>&1)" || STATUS=$?
  "$check" && verdict=pass
  dir="$EVIDENCE/$name"
  mkdir -p "$dir"
  printf '%s\n' "$OUTPUT" > "$dir/setup.log"
  cp "$LOG" "$dir/calls.log"
  cp "$FLAKE_DIR/flake.lock" "$dir/flake.lock"
  cp "$TMP/home/.local/bin/pi" "$dir/pi" 2>/dev/null || true
  NAME="$name" EXPECTED="$expected" VERDICT="$verdict" STATUS="$STATUS" DIR="$dir" \
    REVISION="$(git -C "$ROOT" rev-parse HEAD)$(git -C "$ROOT" diff --quiet HEAD || echo '+dirty')" \
    SELECTED="$(adapter_package)" "$(node_bin)" --input-type=module <<'JS'
import fs from "node:fs";
const env = process.env;
const log = fs.readFileSync(`${env.DIR}/setup.log`, "utf8");
fs.writeFileSync(`${env.DIR}/result.json`, JSON.stringify({
  scenario: env.NAME,
  revision: env.REVISION,
  inputs: {
    workbenchPi: "1.2.3",
    callerPiPackageDir: env.PI_PACKAGE_DIR,
    callerSessionGuard: env.__HM_SESS_VARS_SOURCED ?? null,
    syncRequested: env.PI_ENV_HOME_MANAGER_SYNC === "1",
    nubInstallStatus: env.PI_ENV_TEST_NUB_INSTALL_STATUS ?? "0",
    switchStatus: env.PI_ENV_TEST_SWITCH_STATUS ?? "0",
    generationsReported: !env.PI_ENV_TEST_NO_GENERATIONS,
  },
  expected: env.EXPECTED,
  actual: {
    exitStatus: Number(env.STATUS),
    stageOrder: log.split("\n").filter((line) => ["Dependencies", "Home Manager", "Pi CLI"].includes(line)),
    calls: fs.readFileSync(`${env.DIR}/calls.log`, "utf8").split("\n").filter(Boolean),
    selectedPiPackage: env.SELECTED || null,
  },
  verdict: env.VERDICT,
  reproduce: "bash setup/__tests__/home-manager-sync.test.sh",
  inspect: "setup.log, calls.log, flake.lock, pi",
}, null, 2) + "\n");
JS
  [ "$verdict" = pass ] || fail "$name: $expected (evidence: $dir)"
}

check_old_session_sync() {
  [ "$STATUS" -eq 0 ] && [ "$(adapter_package)" = "$TMP/pi-1.2.3" ] &&
    [ "$(home_manager_calls | tail -1)" = "home-manager generations" ]
}

test_sync_from_old_session_installs_activated_pi() {
  setup_pi_bump_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1
  run_pi_bump_scenario sync-from-old-session \
    "the shell predates the generation; sync switches, reloads it, and installs its Pi 1.2.3" \
    check_old_session_sync
  teardown_pi_bump_fixture
}

check_drift_report() {
  [ "$STATUS" -ne 0 ] && [ -z "$(home_manager_calls)" ] && [ -z "$(adapter_package)" ] &&
    printf '%s' "$OUTPUT" | grep -qF 'run ./setup.sh --sync-home-manager' &&
    printf '%s' "$OUTPUT" | grep -qF 'PI_PACKAGE_DIR supplies it'
}

test_drift_report_precedes_pi_mismatch() {
  setup_pi_bump_fixture
  run_pi_bump_scenario drift-report-precedes-mismatch \
    "without a sync request, setup reports drift, then fails the CLI check and names PI_PACKAGE_DIR" \
    check_drift_report
  teardown_pi_bump_fixture
}

check_dependency_failure() {
  [ "$STATUS" -ne 0 ] && [ -z "$(home_manager_calls)" ] && [ -z "$(adapter_package)" ] &&
    ! stage_ran "Pi CLI"
}

test_dependency_failure_stops_before_home_manager() {
  setup_pi_bump_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1 PI_ENV_TEST_NUB_INSTALL_STATUS=42
  run_pi_bump_scenario dependency-failure-stops \
    "a failed Nub install stops setup before Home Manager and the Pi CLI" \
    check_dependency_failure
  teardown_pi_bump_fixture
}

check_switch_failure() {
  [ "$STATUS" -ne 0 ] && [ "$(home_manager_calls | tail -1)" = "home-manager switch --flake $FLAKE_DIR" ] &&
    [ -z "$(adapter_package)" ] && ! stage_ran "Pi CLI"
}

test_switch_failure_stops_before_pi_cli() {
  setup_pi_bump_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1 PI_ENV_TEST_SWITCH_STATUS=1
  run_pi_bump_scenario switch-failure-stops \
    "a failed home-manager switch stops setup before the reload and the Pi CLI" \
    check_switch_failure
  teardown_pi_bump_fixture
}

check_unreadable_generation() {
  [ "$STATUS" -ne 0 ] && [ -z "$(adapter_package)" ] && ! stage_ran "Pi CLI" &&
    printf '%s' "$OUTPUT" | grep -qF 'Open a new shell, then rerun ./setup.sh.'
}

test_unreadable_generation_reports_recovery() {
  setup_pi_bump_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1 PI_ENV_TEST_NO_GENERATIONS=1
  run_pi_bump_scenario unreadable-generation \
    "if Home Manager reports no current generation, setup stops with recovery steps before the Pi CLI" \
    check_unreadable_generation
  teardown_pi_bump_fixture
}

EVIDENCE=$(mktemp -d "${PI_ENV_SETUP_EVIDENCE_DIR:-${TMPDIR:-/tmp}}/pi-env-home-manager-sync-XXXXXX")
printf 'Home Manager sync evidence: %s\n' "$EVIDENCE"

test_stale_lock_reports_without_sync_request
test_sync_request_updates_and_switches
test_sync_from_old_session_installs_activated_pi
test_drift_report_precedes_pi_mismatch
test_dependency_failure_stops_before_home_manager
test_switch_failure_stops_before_pi_cli
test_unreadable_generation_reports_recovery
test_matching_lock_is_noop
test_skip_conditions
test_update_mismatch_fails_before_switch

echo "home-manager sync tests passed"
