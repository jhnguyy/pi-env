#!/usr/bin/env bash
# pi-env dotfiles setup
#
# Idempotent. Re-run after git pull to pick up new extensions/skills.
#
# Orchestration is grouped by domain/tool instead of by individual command:
#   1. Environment: required software and context-specific recommendations
#   2. Runtime: repo npm dependencies and the user-local pi CLI install
#   3. Pi: settings/package registration, agent context, roles, test utilities
#   4. Terminal tools: tmux plus Ghostty when running on a GUI host/VM
#   5. Repo tools: git hooks
#
# Extensions and skills are loaded by pi's package manager from the repo
# directory — no per-extension or per-skill symlinks needed. Local extensions
# in ~/.pi/agent/extensions/ coexist via pi's auto-discovery.
#
# What stays local (never touched after first run):
#   ~/.pi/agent/auth.json, models.json, sessions/
# setup reapplies the small safe subset in setup/managed-settings.json to settings.json.
#   ~/.pi/agent/extensions/my-extension/ (local-only extensions)

set -euo pipefail

BOOTSTRAP_SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=setup/lib.sh
source "$BOOTSTRAP_SETUP_DIR/lib.sh"
# shellcheck source=setup/options.sh
source "$BOOTSTRAP_SETUP_DIR/options.sh"
setup_parse_args "$@"
# shellcheck source=setup/context.sh
source "$BOOTSTRAP_SETUP_DIR/context.sh"
setup_init_context "$BOOTSTRAP_SETUP_DIR"
# shellcheck source=setup/environment.sh
source "$SETUP_DIR/environment.sh"
# shellcheck source=setup/install.sh
source "$SETUP_DIR/install.sh"
# shellcheck source=setup/configure.sh
source "$SETUP_DIR/configure.sh"

setup_environment() {
  require_node
  setup_check_prerequisites
}

setup_runtime() {
  setup_install_dependencies
  setup_install_pi_cli
}

main() {
  setup_environment
  setup_runtime
  setup_configure_pi
  setup_configure_terminal_tools
  setup_configure_repo_tools
  setup_print_done
}

main "$@"
