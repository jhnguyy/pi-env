#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
# shellcheck source=setup/options.sh
source "$ROOT/setup/options.sh"

reset_setup_env() {
  unset PI_ENV_SETUP_MODE PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_SKIP_TERMINAL PI_ENV_SKIP_PATH_PROFILE PI_ENV_SKIP_REPO_HOOKS PI_ENV_SKIP_HOME_MANAGER PI_ENV_HOME_MANAGER_SYNC || true
}

test_defaults_to_portable() {
  reset_setup_env
  setup_parse_args
  [ "$PI_ENV_SETUP_MODE" = "portable" ] || fail "default setup mode should be portable"
  [ "${PI_ENV_SKIP_TERMINAL:-}" = "0" ] || fail "terminal setup should default enabled"
  [ "${PI_ENV_SKIP_REPO_HOOKS:-}" = "0" ] || fail "repo hooks should default enabled"
  [ "${PI_ENV_SKIP_HOME_MANAGER:-}" = "0" ] || fail "home-manager check should default enabled"
  [ "${PI_ENV_HOME_MANAGER_SYNC:-}" = "0" ] || fail "home-manager update should default off"
}

test_nix_managed_sets_skip_signal() {
  reset_setup_env
  setup_parse_args --nix-managed
  [ "$PI_ENV_SETUP_MODE" = "nix-managed" ] || fail "--nix-managed should set setup mode"
  [ "$PI_ENV_CONFIG_MANAGED_BY_NIX" = "1" ] || fail "--nix-managed should set PI_ENV_CONFIG_MANAGED_BY_NIX"
}

test_nix_managed_env_selects_nix_mode() {
  reset_setup_env
  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  setup_parse_args
  [ "$PI_ENV_SETUP_MODE" = "nix-managed" ] || fail "PI_ENV_CONFIG_MANAGED_BY_NIX should default to nix-managed mode"
}

test_granular_flags() {
  reset_setup_env
  setup_parse_args --no-terminal --no-path --no-repo-hooks --no-home-manager --sync-home-manager
  [ "$PI_ENV_SKIP_TERMINAL" = "1" ] || fail "--no-terminal should set skip flag"
  [ "$PI_ENV_SKIP_PATH_PROFILE" = "1" ] || fail "--no-path should set skip flag"
  [ "$PI_ENV_SKIP_REPO_HOOKS" = "1" ] || fail "--no-repo-hooks should set skip flag"
  [ "$PI_ENV_SKIP_HOME_MANAGER" = "1" ] || fail "--no-home-manager should set skip flag"
  [ "$PI_ENV_HOME_MANAGER_SYNC" = "1" ] || fail "--sync-home-manager should request the update"
}

# A stub nix reports its argv on stdout, which exec passes through setup.sh.
test_nix_entrypoints_delegate_to_nix_setup_app() {
  local tmp output status=0
  tmp="$(with_temp_dir)"
  make_executable "$tmp/nix" '#!/bin/sh
printf "%s\n" "$*"'
  run_setup() {
    env -u PI_ENV_SETUP_MODE -u PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_AUTO_NIX=1 \
      HOME="$tmp/home" PI_AGENT_DIR="$tmp/agent" PI_CODING_AGENT_DIR="$tmp/agent" \
      PATH="$tmp:$PATH" "$ROOT/setup.sh" "$@"
  }

  assert_eq "$(run_setup --no-terminal)" "run .#setup -- --no-terminal" "plain ./setup.sh should auto-run nix setup"
  assert_eq "$(run_setup --use-nix --no-terminal)" "run .#setup -- --no-terminal" "--use-nix should re-exec nix setup"

  make_executable "$tmp/nix" '#!/bin/sh
exit 37'
  run_setup --reset >/dev/null 2>&1 || status=$?
  assert_eq "$status" 37 'Nix failure remains visible'
  [ ! -e "$tmp/agent/settings.json" ] || fail 'Nix failure must not fall back to portable setup'
}

test_later_portable_overrides_nix_managed() {
  reset_setup_env
  setup_parse_args --nix-managed --portable
  [ "$PI_ENV_SETUP_MODE" = "portable" ] || fail "later --portable should set portable mode"
  [ "$PI_ENV_CONFIG_MANAGED_BY_NIX" = "0" ] || fail "later --portable should clear Nix-managed signal"
}

test_defaults_to_portable
test_nix_managed_sets_skip_signal
test_nix_managed_env_selects_nix_mode
test_granular_flags
test_nix_entrypoints_delegate_to_nix_setup_app
test_later_portable_overrides_nix_managed

echo "setup option tests passed"
