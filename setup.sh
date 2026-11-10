#!/usr/bin/env bash
# pi-env dotfiles setup entrypoint.
#
# The implementation lives under setup/ so paths are anchored consistently and
# related setup assets stay together. This wrapper preserves the existing
# ./setup.sh command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PI_ENV_REPO="$SCRIPT_DIR"
# Resolve selectors before a Nix re-exec changes the working directory.
source "$SCRIPT_DIR/setup/agent-dir.sh"
pi_env_resolve_agent_dir

has_explicit_setup_mode() {
  [ -n "${PI_ENV_SETUP_MODE:-}" ] && return 0
  for arg in "$@"; do
    case "$arg" in
      --use-nix|--nix-managed|--portable|-h|--help) return 0 ;;
    esac
  done
  return 1
}

# Validate the complete argv before dispatch, including arguments after --help.
source "$SCRIPT_DIR/setup/options.sh"
setup_validate_args "$@"
setup_args=()
use_nix=0
show_help=0
for arg in "$@"; do
  case "$arg" in
    --use-nix) use_nix=1 ;;
    -h|--help) show_help=1; setup_args+=("$arg") ;;
    *) setup_args+=("$arg") ;;
  esac
done
if [ "$show_help" = "1" ]; then
  exec "$SCRIPT_DIR/setup/main.sh" --help
fi

if [ "$use_nix" = "1" ]; then
  set -- "${setup_args[@]}"
  if ! command -v nix >/dev/null 2>&1; then
    echo "./setup.sh --use-nix requires nix with flakes enabled." >&2
    exit 127
  fi
  cd "$SCRIPT_DIR"
  exec nix run .#setup -- "$@"
fi

if ! has_explicit_setup_mode "$@" && [ "${PI_ENV_AUTO_NIX:-1}" = "1" ] && [ "${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" != "1" ] && command -v nix >/dev/null 2>&1; then
  cd "$SCRIPT_DIR"
  exec nix run .#setup -- "$@"
fi

exec "$SCRIPT_DIR/setup/main.sh" "$@"
