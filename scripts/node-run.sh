#!/usr/bin/env sh
# Run a Node.js script with a Node binary that works in Nix and nub-managed shells.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/node-run.sh <script> [args...]" >&2
  exit 2
fi

script="$1"
shift

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node_run_repo="${PI_ENV_REPO:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=setup/node-runtime.sh
. "$node_run_repo/setup/node-runtime.sh"

PI_ENV_NODE_BIN="$(pi_env_select_node_bin "$node_run_repo")"
export PI_ENV_NODE_BIN
exec "$PI_ENV_NODE_BIN" "$script" "$@"
