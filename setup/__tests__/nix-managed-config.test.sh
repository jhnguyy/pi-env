#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

node_bin() {
  if [ -n "${PI_ENV_NODE_BIN:-}" ] && [ -x "$PI_ENV_NODE_BIN" ]; then
    printf '%s\n' "$PI_ENV_NODE_BIN"
  elif [ -x /bin/node ]; then
    printf '%s\n' /bin/node
  else
    command -v node
  fi
}

run_terminal_config() {
  local node
  node=$(node_bin)
  REPO="$ROOT" \
  SETUP_DIR="$ROOT/setup" \
  PI_AGENT_DIR="$HOME/.pi/agent" \
  AGENTS_DIR="$HOME/.agents" \
  SETTINGS_FILE="$HOME/.pi/agent/settings.json" \
  MANAGED_SETTINGS_FILE="$ROOT/setup/managed-settings.json" \
  PI_BIN_DIR="$HOME/.local/bin" \
  TMUX_CONF="$HOME/.tmux.conf" \
  TMUX_SOURCE_LINE="source-file $ROOT/setup/tmux.conf" \
  GHOSTTY_CONFIG_DIR="$HOME/.config/ghostty" \
  APPEND_SRC="$ROOT/.pi/agent/APPEND_SYSTEM.md" \
  APPEND_DST="$HOME/.pi/agent/APPEND_SYSTEM.md" \
  APPEND_MARKER="<!-- pi-env:append-system -->" \
  TEST_UTILS_DIR="$HOME/.pi/agent/extensions/__tests__" \
  POST_MERGE_HOOK_SRC="$ROOT/setup/post-merge" \
  PRE_COMMIT_HOOK_SRC="$ROOT/setup/pre-commit" \
  SHOULD_LINK_GHOSTTY="${SHOULD_LINK_GHOSTTY:-1}" \
  CONTEXT_LABEL="${CONTEXT_LABEL:-host}" \
  PI_ENV_CONFIG_MANAGED_BY_NIX="${PI_ENV_CONFIG_MANAGED_BY_NIX:-}" \
  PI_ENV_SKIP_TMUX="${PI_ENV_SKIP_TMUX:-}" \
  PI_ENV_SKIP_GHOSTTY="${PI_ENV_SKIP_GHOSTTY:-}" \
  "$node" "$ROOT/setup/configure.mjs" terminal "$node" >/dev/null
}

test_nix_managed_config_skips_terminal_writes() {
  local old_home="${HOME:-}" tmp_home
  tmp_home="$(mktemp -d)"
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
  tmp_home="$(mktemp -d)"
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
