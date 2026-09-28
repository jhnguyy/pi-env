#!/usr/bin/env bash
# Re-runnable after pulls; preserves local auth, sessions, model choices, and extensions.
# Only setup/config/managed-settings.json is reapplied to user settings.

set -euo pipefail

BOOTSTRAP_SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=setup/lib.sh
source "$BOOTSTRAP_SETUP_DIR/lib.sh"
# shellcheck source=setup/options.sh
source "$BOOTSTRAP_SETUP_DIR/options.sh"
PI_ENV_CONFIG_MANAGED_BY_NIX_AT_ENTRY="${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}"
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
# shellcheck source=setup/bootstrap-nub.sh
source "$SETUP_DIR/bootstrap-nub.sh"

setup_environment() {
  setup_bootstrap_nub
  require_node
  setup_check_prerequisites
}

setup_runtime() {
  setup_install_runtime
}

main() {
  setup_environment
  setup_runtime
  setup_configure_all
  setup_print_done
}

main "$@"
