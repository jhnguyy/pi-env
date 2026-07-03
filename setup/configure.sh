#!/usr/bin/env bash
# Pi, terminal, and repo-tool configuration. Implementation lives in
# configure.mjs; this shell bridge only passes setup context from Bash.

setup_configure_all() {
  local setup_node_bin
  setup_node_bin=$(resolve_setup_node_bin)
  REPO="$REPO" \
  SETUP_DIR="$SETUP_DIR" \
  PI_AGENT_DIR="$PI_AGENT_DIR" \
  AGENTS_DIR="$AGENTS_DIR" \
  SETTINGS_FILE="$SETTINGS_FILE" \
  MANAGED_SETTINGS_FILE="$MANAGED_SETTINGS_FILE" \
  PI_BIN_DIR="$PI_BIN_DIR" \
  TMUX_CONF="$TMUX_CONF" \
  TMUX_SOURCE_LINE="$TMUX_SOURCE_LINE" \
  GHOSTTY_CONFIG_DIR="$GHOSTTY_CONFIG_DIR" \
  APPEND_SRC="$APPEND_SRC" \
  APPEND_DST="$APPEND_DST" \
  APPEND_MARKER="$APPEND_MARKER" \
  TEST_UTILS_DIR="$TEST_UTILS_DIR" \
  POST_MERGE_HOOK_SRC="$POST_MERGE_HOOK_SRC" \
  PRE_COMMIT_HOOK_SRC="$PRE_COMMIT_HOOK_SRC" \
  SHOULD_LINK_GHOSTTY="$should_link_ghostty" \
  CONTEXT_LABEL="$context_label" \
  "$setup_node_bin" "$SETUP_DIR/configure.mjs" all "$setup_node_bin"
}

setup_print_done() {
  echo ""
  echo "Done."
  echo "  Setup mode:     ${PI_ENV_SETUP_MODE:-portable}"
  echo "  Pi CLI:         $PI_BIN_DIR/pi"
  echo "  Machine config: ~/.pi/agent/{auth.json,settings.json}"
  echo "  Install check:  cd $REPO && nub run verify:install"
  echo "  Merge check:    cd $REPO && nub run verify"
}
