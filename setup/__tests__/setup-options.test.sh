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
  [ "$PI_ENV_RESET_SETTINGS" = "0" ] || fail "🤖: reset must not be implicit"
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
  setup_parse_args --reset --no-terminal --no-path --no-repo-hooks --no-home-manager --sync-home-manager
  [ "$PI_ENV_RESET_SETTINGS" = "1" ] || fail "🤖: --reset should request reset"
  [ "$PI_ENV_SKIP_TERMINAL" = "1" ] || fail "--no-terminal should set skip flag"
  [ "$PI_ENV_SKIP_PATH_PROFILE" = "1" ] || fail "--no-path should set skip flag"
  [ "$PI_ENV_SKIP_REPO_HOOKS" = "1" ] || fail "--no-repo-hooks should set skip flag"
  [ "$PI_ENV_SKIP_HOME_MANAGER" = "1" ] || fail "--no-home-manager should set skip flag"
  [ "$PI_ENV_HOME_MANAGER_SYNC" = "1" ] || fail "--sync-home-manager should request the update"
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

test_terminal_config_paths() {
  local tmp
  tmp="$(with_temp_dir)"
  mkdir -p "$tmp/home"
  env -u GHOSTTY_CONFIG_DIR ROOT="$ROOT" HOME="$tmp/home" bash -c '
    set -e
    source "$ROOT/setup/context.sh"
    uname() { printf "Darwin\\n"; }
    setup_init_context "$ROOT/setup"
    [ "$GHOSTTY_CONFIG_DIR" = "$HOME/Library/Application Support/com.mitchellh.ghostty" ] || exit 1
    GHOSTTY_CONFIG_DIR="$HOME/custom-ghostty"
    setup_init_context "$ROOT/setup"
    [ "$GHOSTTY_CONFIG_DIR" = "$HOME/custom-ghostty" ] || exit 1
  ' || fail "macOS Ghostty default or explicit override is incorrect"
  env -u GHOSTTY_CONFIG_DIR ROOT="$ROOT" HOME="$tmp/home" bash -c '
    set -e
    source "$ROOT/setup/context.sh"
    uname() { printf "Linux\\n"; }
    setup_init_context "$ROOT/setup"
    [ "$GHOSTTY_CONFIG_DIR" = "$HOME/.config/ghostty" ]
  ' || fail "Linux Ghostty default is incorrect"
  rm -rf "$tmp"
}

test_nix_failure_does_not_retry_setup() {
  local tmp status
  tmp="$(with_temp_dir)"
  mkdir -p "$tmp/home"
  make_executable "$tmp/nix" '#!/bin/sh
exit 37'
  set +e
  env -u PI_ENV_SETUP_MODE -u PI_ENV_CONFIG_MANAGED_BY_NIX HOME="$tmp/home" PATH="$tmp:$PATH" "$ROOT/setup.sh" --reset >"$tmp/output" 2>&1
  status=$?
  set -e
  assert_eq "$status" 37 'Nix failure remains visible'
  [ ! -e "$tmp/home/.pi/agent/settings.json" ] || fail 'Nix failure must not retry/reset through portable setup'
  rm -rf "$tmp"
}

test_nix_failure_does_not_retry_setup
test_defaults_to_portable
test_terminal_config_paths
test_nix_managed_sets_skip_signal
test_nix_managed_env_selects_nix_mode
test_granular_flags
test_auto_nix_entrypoint_uses_nix_setup_app
test_use_nix_entrypoint_reexecs_nix_setup_app
test_later_portable_overrides_nix_managed

echo "setup option tests passed"
