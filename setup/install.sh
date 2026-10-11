#!/usr/bin/env bash
setup_run_runtime() {
  local setup_node_bin
  setup_node_bin=$(resolve_setup_node_bin)
  REPO="$REPO" \
  SETUP_DIR="$SETUP_DIR" \
  PI_BIN_DIR="$PI_BIN_DIR" \
  "$setup_node_bin" "$SETUP_DIR/runtime.mjs" "$setup_node_bin" "$1"
}

# Home Manager can supply Pi, so sync it after dependencies exist and before the Pi CLI check.
setup_install_runtime() {
  setup_run_runtime dependencies
  setup_sync_home_manager
  setup_run_runtime pi-cli
}
