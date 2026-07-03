#!/usr/bin/env sh
# Run a Node.js script with a Node binary that works in Nix and nub-managed shells.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/node-run.sh <script> [args...]" >&2
  exit 2
fi

script="$1"
shift

try_node() {
  candidate="$1"
  shift
  [ -n "$candidate" ] || return 1
  [ -x "$candidate" ] || return 1
  "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 || return 1
  exec "$candidate" "$script" "$@"
}

if [ -n "${PI_ENV_NODE_BIN:-}" ]; then
  try_node "$PI_ENV_NODE_BIN" "$@" || {
    echo "pi-env: PI_ENV_NODE_BIN is not usable: $PI_ENV_NODE_BIN" >&2
    exit 127
  }
fi

# In Nix-managed containers, /bin/node is often the patched executable while
# nub's downloaded Node can be unusable because its dynamic linker/libs are not
# present. Prefer /bin/node before PATH lookup.
try_node /bin/node "$@" || true

path_node=$(command -v node 2>/dev/null || true)
try_node "$path_node" "$@" || true

if command -v nub >/dev/null 2>&1; then
  nub_node=$(nub node which 2>/dev/null || true)
  try_node "$nub_node" "$@" || true
fi

echo "pi-env: no usable Node.js >=22 found; set PI_ENV_NODE_BIN" >&2
exit 127
