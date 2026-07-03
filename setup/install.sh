#!/usr/bin/env bash
# Dependency and pi CLI installation. Heavy runtime work lives in runtime.mjs so
# probing, process execution, and wrapper generation can be tested and evolved
# without expanding Bash control flow.

setup_install_runtime() {
  local setup_node_bin
  setup_node_bin=$(resolve_setup_node_bin)
  REPO="$REPO" \
  SETUP_DIR="$SETUP_DIR" \
  PI_BIN_DIR="$PI_BIN_DIR" \
  "$setup_node_bin" "$SETUP_DIR/runtime.mjs" "$setup_node_bin"
}
