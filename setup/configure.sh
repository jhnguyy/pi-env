#!/usr/bin/env bash
setup_run_configure() {
  local setup_node_bin
  setup_node_bin=$(resolve_setup_node_bin)
  REPO="$REPO" \
  SETUP_DIR="$SETUP_DIR" \
  PI_AGENT_DIR="$PI_AGENT_DIR" \
  AGENTS_DIR="$AGENTS_DIR" \
  SETTINGS_FILE="$SETTINGS_FILE" \
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
  SHOULD_LINK_GHOSTTY="${should_link_ghostty:-0}" \
  CONTEXT_LABEL="${context_label:-}" \
  "$setup_node_bin" "$SETUP_DIR/configure.mjs" "$1" "$setup_node_bin"
}

setup_sync_home_manager() {
  setup_run_configure home-manager
  # The caller's environment predates the switch; reload the activated profile's
  # variables so later stages use the Pi and Node it supplies.
  if [ "${PI_ENV_HOME_MANAGER_SYNC:-0}" = "1" ] && [ -r "${PI_ENV_HOME_MANAGER_SESSION_VARS:-}" ]; then
    unset __HM_SESS_VARS_SOURCED
    set +u
    # shellcheck source=/dev/null
    . "$PI_ENV_HOME_MANAGER_SESSION_VARS"
    set -u
  fi
}

setup_configure_all() {
  setup_run_configure all
}

setup_print_done() {
  echo ""
  echo "Done."
  echo "  Setup mode:     ${PI_ENV_SETUP_MODE:-portable}"
  echo "  Pi CLI:         $PI_BIN_DIR/pi"
  echo "  Machine config: $PI_AGENT_DIR/{auth.json,settings.json}"
  echo "  Install check:  cd $REPO && nub run verify:install"
  echo "  Merge check:    cd $REPO && nub run verify"
}
