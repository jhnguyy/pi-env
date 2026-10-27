#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"

run_terminal_config() {
  SHOULD_LINK_GHOSTTY="${SHOULD_LINK_GHOSTTY:-1}" \
  CONTEXT_LABEL="${CONTEXT_LABEL:-host}" \
  PI_ENV_CONFIG_MANAGED_BY_NIX="${PI_ENV_CONFIG_MANAGED_BY_NIX:-}" \
  PI_ENV_SKIP_TMUX="${PI_ENV_SKIP_TMUX:-}" \
  PI_ENV_SKIP_GHOSTTY="${PI_ENV_SKIP_GHOSTTY:-}" \
  run_configure terminal "$ROOT" "$HOME" >/dev/null
}

test_nix_managed_config_skips_terminal_writes() {
  local old_home="${HOME:-}" tmp_home
  tmp_home="$(with_temp_dir)"
  HOME="$tmp_home"

  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  SHOULD_LINK_GHOSTTY=1
  CONTEXT_LABEL=host

  run_terminal_config

  [ ! -e "$HOME/.tmux.conf" ] || fail "tmux config should not be created when Nix manages config"
  [ ! -e "$HOME/.config/ghostty/config" ] || fail "Ghostty config should not be linked when Nix manages config"

  unset PI_ENV_CONFIG_MANAGED_BY_NIX SHOULD_LINK_GHOSTTY CONTEXT_LABEL
  HOME="$old_home"
  rm -rf "$tmp_home"
}

test_granular_skip_flags_skip_terminal_writes() {
  local old_home="${HOME:-}" tmp_home
  tmp_home="$(with_temp_dir)"
  HOME="$tmp_home"

  PI_ENV_SKIP_TMUX=1
  PI_ENV_SKIP_GHOSTTY=1
  SHOULD_LINK_GHOSTTY=1
  CONTEXT_LABEL=host

  run_terminal_config

  [ ! -e "$HOME/.tmux.conf" ] || fail "tmux config should not be created when PI_ENV_SKIP_TMUX=1"
  [ ! -e "$HOME/.config/ghostty/config" ] || fail "Ghostty config should not be linked when PI_ENV_SKIP_GHOSTTY=1"

  unset PI_ENV_SKIP_TMUX PI_ENV_SKIP_GHOSTTY SHOULD_LINK_GHOSTTY CONTEXT_LABEL
  HOME="$old_home"
  rm -rf "$tmp_home"
}

test_nix_managed_config_skips_terminal_writes
test_granular_skip_flags_skip_terminal_writes

echo "nix-managed config tests passed"
