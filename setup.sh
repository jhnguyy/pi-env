#!/usr/bin/env bash
# pi-env dotfiles setup entrypoint.
#
# The implementation lives under setup/ so paths are anchored consistently and
# related setup assets stay together. This wrapper preserves the existing
# ./setup.sh command.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/setup/main.sh" "$@"
