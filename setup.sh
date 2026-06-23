#!/usr/bin/env bash
# pi-env dotfiles setup entrypoint.
#
# The implementation lives under setup/ so paths are anchored consistently and
# related setup assets stay together. This wrapper preserves the existing
# ./setup.sh command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--use-nix" ]; then
  shift
  if ! command -v nix >/dev/null 2>&1; then
    echo "./setup.sh --use-nix requires nix with flakes enabled." >&2
    exit 127
  fi
  cd "$SCRIPT_DIR"
  exec nix run .#setup -- "$@"
fi

exec "$SCRIPT_DIR/setup/main.sh" "$@"
