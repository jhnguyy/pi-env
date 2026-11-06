#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

commit() {
  git -C "$1" -c commit.gpgsign=false commit -q --allow-empty -m "$2"
}

# Stubs report calls on stderr; keep only those lines from captured output.
calls() {
  sed -n 's/^call: //p' <<<"$1"
}

# A published main checkout whose Home Manager input is stale, and a Pi package per
# generation: the caller's shell has 1.0.0, the checkout and the new generation 1.2.3.
setup_fixture() {
  local node
  TMP="$(with_temp_dir)"
  REPO_DIR="$TMP/repo"
  FLAKE_DIR="$TMP/home-manager"
  STUB_DIR="$TMP/bin"
  node="$(node_bin)"
  mkdir -p "$REPO_DIR/scripts" "$REPO_DIR/node_modules/@earendil-works" "$FLAKE_DIR" "$STUB_DIR"
  git -C "$REPO_DIR" init -q -b main
  git -C "$REPO_DIR" config user.email test@example.invalid
  git -C "$REPO_DIR" config user.name 'pi-env test'
  commit "$REPO_DIR" init
  git -C "$REPO_DIR" remote add origin https://example.invalid/pi-env.git
  git -C "$REPO_DIR" update-ref refs/remotes/origin/main HEAD
  git -C "$REPO_DIR" branch -q --set-upstream-to=origin/main main
  printf '{"nodes":{"root":{"inputs":{"pi-env":"pi-env"}},"pi-env":{"locked":{"rev":"%040d"}}},"root":"root","version":7}\n' 0 \
    > "$FLAKE_DIR/flake.lock"

  cp "$ROOT/scripts/check-node-version.mjs" "$ROOT/scripts/node-policy.mjs" "$REPO_DIR/scripts/"
  printf '{"engines":{"node":">=%s"},"devDependencies":{"@earendil-works/pi-coding-agent":"1.2.3"}}\n' \
    "$("$node" -p 'process.versions.node')" > "$REPO_DIR/package.json"
  write_pi_package "$REPO_DIR/node_modules/@earendil-works/pi-coding-agent" 1.2.3
  write_pi_package "$TMP/pi-1.0.0" 1.0.0
  write_pi_package "$TMP/pi-1.2.3" 1.2.3
  write_generation "$TMP/generations/old" "$TMP/pi-1.0.0"
  write_generation "$TMP/generations/new" "$TMP/pi-1.2.3"
  echo "$TMP/generations/old" > "$TMP/generations/current"

  make_executable "$STUB_DIR/nub" '#!/bin/sh'
  make_executable "$STUB_DIR/nix" '#!/bin/sh
echo "call: nix $*" >&2'
  make_executable "$STUB_DIR/home-manager" '#!/bin/sh
case "$1" in
  switch)
    echo "call: home-manager $*" >&2
    echo "$PI_ENV_TEST_GENERATIONS/new" > "$PI_ENV_TEST_GENERATIONS/current" ;;
  generations)
    printf "2026-01-01 00:00 : id 2 -> %s (current)\n" "$(cat "$PI_ENV_TEST_GENERATIONS/current")" ;;
esac'
  export PI_ENV_TEST_GENERATIONS="$TMP/generations" PI_ENV_HOME_MANAGER_FLAKE="$FLAKE_DIR"
  export PI_ENV_NODE_BIN="$node" PI_ENV_CONFIG_MANAGED_BY_NIX=1
  export PI_PACKAGE_DIR="$TMP/pi-1.0.0" __HM_SESS_VARS_SOURCED=1
  unset PI_ENV_HOME_MANAGER_SYNC || true
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

# Runs the real runtime stage sequence in a fresh errexit shell, as setup/main.sh does.
run_setup_runtime() {
  env PATH="$STUB_DIR:$PATH" ROOT="$ROOT" REPO="${1:-$REPO_DIR}" TMP="$TMP" \
    AGENTS_DIR="$TMP/home/.agents" XDG_CONFIG_HOME="$TMP/home/.config" \
    GHOSTTY_CONFIG_DIR="$TMP/home/.config/ghostty" \
    bash -euo pipefail -c '
      source "$ROOT/setup/lib.sh"
      source "$ROOT/setup/install.sh"
      source "$ROOT/setup/configure.sh"
      SETUP_DIR="$ROOT/setup" PI_BIN_DIR="$TMP/home/.local/bin"
      PI_AGENT_DIR="$TMP/home/.pi/agent"
      setup_install_runtime' 2>&1
}

adapter_package() {
  sed -n "s/^DEFAULT_PI_PACKAGE_DIR='\(.*\)'$/\1/p" "$TMP/home/.local/bin/pi" 2>/dev/null || true
}

# Setup runs on every pull, so a stale input is reported, never activated implicitly.
test_drift_without_request_does_not_activate() {
  local output
  setup_fixture

  output="$(run_setup_runtime)" || true

  assert_eq "$(calls "$output")" "" "setup without --sync-home-manager should not update or switch"
}

# The input fetches the published branch, so only a published main may be pinned.
test_sync_never_pins_unpublished_work() {
  local output all=""
  setup_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1

  git -C "$REPO_DIR" switch -q -c feature/test
  output="$(run_setup_runtime)" || true
  all+=$output$'\n'
  git -C "$REPO_DIR" switch -q main
  git -C "$REPO_DIR" worktree add -q "$TMP/worktree" -b feature/worktree
  output="$(run_setup_runtime "$TMP/worktree")" || true
  all+=$output$'\n'
  commit "$REPO_DIR" unpushed
  output="$(run_setup_runtime)" || true
  all+=$output$'\n'

  assert_eq "$(calls "$all")" "" "a branch, worktree, or unpushed main should not update or switch"
}

# The caller's shell predates the switch; the Pi CLI must come from the activated generation.
test_sync_installs_pi_from_activated_generation() {
  local output
  setup_fixture
  export PI_ENV_HOME_MANAGER_SYNC=1

  output="$(run_setup_runtime)" || fail "sync from an old shell should succeed (got: $output)"

  assert_eq "$(adapter_package)" "$TMP/pi-1.2.3" "Pi wrapper should use the activated generation's package"
}

test_drift_without_request_does_not_activate
test_sync_never_pins_unpublished_work
test_sync_installs_pi_from_activated_generation

echo "home-manager sync tests passed"
