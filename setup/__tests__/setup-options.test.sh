#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=setup/options.sh
source "$ROOT/setup/options.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

reset_setup_env() {
  unset PI_ENV_SETUP_MODE PI_ENV_CONFIG_MANAGED_BY_NIX PI_ENV_SKIP_TERMINAL PI_ENV_SKIP_PATH_PROFILE PI_ENV_SKIP_REPO_HOOKS || true
}

test_defaults_to_portable() {
  reset_setup_env
  setup_parse_args
  [ "$PI_ENV_SETUP_MODE" = "portable" ] || fail "default setup mode should be portable"
  [ "${PI_ENV_SKIP_TERMINAL:-}" = "0" ] || fail "terminal setup should default enabled"
  [ "${PI_ENV_SKIP_REPO_HOOKS:-}" = "0" ] || fail "repo hooks should default enabled"
}

test_nix_managed_sets_skip_signal() {
  reset_setup_env
  setup_parse_args --nix-managed
  [ "$PI_ENV_SETUP_MODE" = "nix-managed" ] || fail "--nix-managed should set setup mode"
  [ "$PI_ENV_CONFIG_MANAGED_BY_NIX" = "1" ] || fail "--nix-managed should set PI_ENV_CONFIG_MANAGED_BY_NIX"
}

test_granular_flags() {
  reset_setup_env
  setup_parse_args --no-terminal --no-path --no-repo-hooks
  [ "$PI_ENV_SKIP_TERMINAL" = "1" ] || fail "--no-terminal should set skip flag"
  [ "$PI_ENV_SKIP_PATH_PROFILE" = "1" ] || fail "--no-path should set skip flag"
  [ "$PI_ENV_SKIP_REPO_HOOKS" = "1" ] || fail "--no-repo-hooks should set skip flag"
}

test_later_portable_overrides_nix_managed() {
  reset_setup_env
  setup_parse_args --nix-managed --portable
  [ "$PI_ENV_SETUP_MODE" = "portable" ] || fail "later --portable should set portable mode"
  [ "$PI_ENV_CONFIG_MANAGED_BY_NIX" = "0" ] || fail "later --portable should clear Nix-managed signal"
}

test_defaults_to_portable
test_nix_managed_sets_skip_signal
test_granular_flags
test_later_portable_overrides_nix_managed

echo "setup option tests passed"
