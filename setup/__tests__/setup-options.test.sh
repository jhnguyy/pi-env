#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
# shellcheck source=setup/options.sh
source "$ROOT/setup/options.sh"

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

test_nix_managed_env_selects_nix_mode() {
  reset_setup_env
  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  setup_parse_args
  [ "$PI_ENV_SETUP_MODE" = "nix-managed" ] || fail "PI_ENV_CONFIG_MANAGED_BY_NIX should default to nix-managed mode"
}

test_granular_flags() {
  reset_setup_env
  setup_parse_args --no-terminal --no-path --no-repo-hooks
  [ "$PI_ENV_SKIP_TERMINAL" = "1" ] || fail "--no-terminal should set skip flag"
  [ "$PI_ENV_SKIP_PATH_PROFILE" = "1" ] || fail "--no-path should set skip flag"
  [ "$PI_ENV_SKIP_REPO_HOOKS" = "1" ] || fail "--no-repo-hooks should set skip flag"
}

test_auto_nix_entrypoint_uses_nix_setup_app() {
  local tmp old_path output
  tmp="$(with_temp_dir)"
  old_path="$PATH"
  output="$tmp/out"
  cat > "$tmp/nix" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$PI_ENV_TEST_NIX_OUT"
SH
  chmod +x "$tmp/nix"

  env -u PI_ENV_SETUP_MODE -u PI_ENV_CONFIG_MANAGED_BY_NIX PATH="$tmp:$PATH" PI_ENV_TEST_NIX_OUT="$output" "$ROOT/setup.sh" --no-terminal

  [ "$(cat "$output")" = "run .#setup -- --no-terminal" ] || fail "plain ./setup.sh should auto-run nix setup when available"

  PATH="$old_path"
  rm -rf "$tmp"
}

test_use_nix_entrypoint_reexecs_nix_setup_app() {
  local tmp old_path output
  tmp="$(with_temp_dir)"
  old_path="$PATH"
  output="$tmp/out"
  cat > "$tmp/nix" <<'SH'
#!/bin/sh
printf '%s\n' "$*" > "$PI_ENV_TEST_NIX_OUT"
SH
  chmod +x "$tmp/nix"

  env -u PI_ENV_SETUP_MODE -u PI_ENV_CONFIG_MANAGED_BY_NIX PATH="$tmp:$PATH" PI_ENV_TEST_NIX_OUT="$output" "$ROOT/setup.sh" --use-nix --no-terminal

  [ "$(cat "$output")" = "run .#setup -- --no-terminal" ] || fail "--use-nix should re-exec nix run .#setup with remaining args"

  PATH="$old_path"
  rm -rf "$tmp"
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
test_auto_nix_entrypoint_uses_nix_setup_app
test_use_nix_entrypoint_reexecs_nix_setup_app
test_later_portable_overrides_nix_managed

echo "setup option tests passed"
