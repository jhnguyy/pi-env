#!/usr/bin/env bash
setup_init_context() {
  SETUP_DIR="$(cd "$1" && pwd)"
  REPO="$(cd "$SETUP_DIR/.." && pwd)"

  PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
  AGENTS_DIR="${AGENTS_DIR:-$HOME/.agents}"
  SETTINGS_FILE="$PI_AGENT_DIR/settings.json"
  MANAGED_SETTINGS_FILE="$SETUP_DIR/config/managed-settings.json"

  PI_CLI_ROOT="${PI_CLI_ROOT:-$HOME/.local/share/pi-env/pi-cli}"
  PI_BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"

  TMUX_THEME_SRC="$SETUP_DIR/templates/tmux.conf"
  TMUX_CONF="$HOME/.tmux.conf"
  TMUX_SOURCE_LINE="source-file $TMUX_THEME_SRC"

  GHOSTTY_CONFIG_DIR="${GHOSTTY_CONFIG_DIR:-$HOME/.config/ghostty}"

  APPEND_SRC="$REPO/.pi/agent/APPEND_SYSTEM.md"
  APPEND_DST="$PI_AGENT_DIR/APPEND_SYSTEM.md"
  APPEND_MARKER="<!-- pi-env:append-system -->"

  TEST_UTILS_DIR="$PI_AGENT_DIR/extensions/__tests__"
  POST_MERGE_HOOK_SRC="$SETUP_DIR/hooks/post-merge"
  PRE_COMMIT_HOOK_SRC="$SETUP_DIR/hooks/pre-commit"
}
