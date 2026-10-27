#!/usr/bin/env bash
# Setup's Node steps derive their own paths from REPO, HOME, and the agent directory.
setup_init_context() {
  SETUP_DIR="$(cd "$1" && pwd)"
  REPO="$(cd "$SETUP_DIR/.." && pwd)"

  source "$SETUP_DIR/agent-dir.sh"
  pi_env_resolve_agent_dir || return $?
  PI_BIN_DIR="${PI_BIN_DIR:-$HOME/.local/bin}"
}
