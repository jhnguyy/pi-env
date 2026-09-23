#!/usr/bin/env bash
# pi-env dotfiles setup entrypoint.
#
# The implementation lives under setup/ so paths are anchored consistently and
# related setup assets stay together. This wrapper preserves the existing
# ./setup.sh command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

has_explicit_setup_mode() {
  [ -n "${PI_ENV_SETUP_MODE:-}" ] && return 0
  for arg in "$@"; do
    case "$arg" in
      --use-nix|--nix-managed|--portable) return 0 ;;
    esac
  done
  return 1
}

if [ "${1:-}" = "--use-nix" ]; then
  shift
  if ! command -v nix >/dev/null 2>&1; then
    echo "./setup.sh --use-nix requires nix with flakes enabled." >&2
    exit 127
  fi
  cd "$SCRIPT_DIR"
  exec nix run .#setup -- "$@"
fi

if ! has_explicit_setup_mode "$@" && [ "${PI_ENV_AUTO_NIX:-1}" = "1" ] && [ "${PI_ENV_CONFIG_MANAGED_BY_NIX:-0}" != "1" ] && command -v nix >/dev/null 2>&1; then
  cd "$SCRIPT_DIR"
  # Nix may have already started setup. Do not retry with PATH tools after a
  # failure: that could run a second install with an incompatible Nub.
  exec nix run .#setup -- "$@"
fi

exec "$SCRIPT_DIR/setup/main.sh" "$@"
