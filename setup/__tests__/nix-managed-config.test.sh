#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=setup/lib.sh
source "$ROOT/setup/lib.sh"
# shellcheck source=setup/configure.sh
source "$ROOT/setup/configure.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_nix_managed_config_skips_terminal_writes() {
  local old_home="${HOME:-}" tmp_home
  tmp_home="$(mktemp -d)"
  HOME="$tmp_home"

  PI_ENV_CONFIG_MANAGED_BY_NIX=1
  TMUX_CONF="$HOME/.tmux.conf"
  TMUX_SOURCE_LINE="source-file $ROOT/setup/tmux.conf"
  GHOSTTY_CONFIG_DIR="$HOME/.config/ghostty"
  REPO="$ROOT"
  should_link_ghostty=1
  context_label="host"

  setup_configure_tmux >/dev/null
  setup_configure_ghostty >/dev/null

  [ ! -e "$TMUX_CONF" ] || fail "tmux config should not be created when Nix manages config"
  [ ! -e "$GHOSTTY_CONFIG_DIR/config" ] || fail "Ghostty config should not be linked when Nix manages config"

  unset PI_ENV_CONFIG_MANAGED_BY_NIX
  HOME="$old_home"
  rm -rf "$tmp_home"
}

test_granular_skip_flags_skip_terminal_writes() {
  local old_home="${HOME:-}" tmp_home
  tmp_home="$(mktemp -d)"
  HOME="$tmp_home"

  PI_ENV_SKIP_TMUX=1
  PI_ENV_SKIP_GHOSTTY=1
  TMUX_CONF="$HOME/.tmux.conf"
  TMUX_SOURCE_LINE="source-file $ROOT/setup/tmux.conf"
  GHOSTTY_CONFIG_DIR="$HOME/.config/ghostty"
  REPO="$ROOT"
  should_link_ghostty=1
  context_label="host"

  setup_configure_tmux >/dev/null
  setup_configure_ghostty >/dev/null

  [ ! -e "$TMUX_CONF" ] || fail "tmux config should not be created when PI_ENV_SKIP_TMUX=1"
  [ ! -e "$GHOSTTY_CONFIG_DIR/config" ] || fail "Ghostty config should not be linked when PI_ENV_SKIP_GHOSTTY=1"

  unset PI_ENV_SKIP_TMUX PI_ENV_SKIP_GHOSTTY
  HOME="$old_home"
  rm -rf "$tmp_home"
}

test_nix_managed_config_skips_terminal_writes
test_granular_skip_flags_skip_terminal_writes

echo "nix-managed config tests passed"
