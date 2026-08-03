#!/usr/bin/env sh
# Run native-tool JavaScript launchers with a host Node executable.
# Nub can use a dynamic loader to run its downloaded Node. Oxlint and Oxfmt
# start child processes through process.execPath, so they need a directly
# executable host Node. Both tools support ^20.19.0 or >=22.12.0 independently
# of the pi-env Node 24 application runtime policy.
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: scripts/tool-node-run.sh <script> [args...]" >&2
  exit 2
fi

tool_node_supported() {
  version="$($1 -p 'process.versions.node' 2>/dev/null || true)"
  major=${version%%.*}
  rest=${version#*.}
  minor=${rest%%.*}
  case "$major:$minor" in
    20:*) [ "$minor" -ge 19 ] 2>/dev/null ;;
    *) [ "$major" -ge 22 ] 2>/dev/null && { [ "$major" -gt 22 ] || [ "$minor" -ge 12 ]; } ;;
  esac
}

node_bin="${PI_ENV_TOOL_NODE:-}"
if [ -n "$node_bin" ]; then
  if [ ! -x "$node_bin" ] || ! tool_node_supported "$node_bin"; then
    echo "PI_ENV_TOOL_NODE must be executable and satisfy ^20.19.0 or >=22.12.0." >&2
    exit 1
  fi
else
  node_bin=""
  for candidate in /bin/node /usr/bin/node "$(command -v node || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && tool_node_supported "$candidate"; then
      node_bin="$candidate"
      break
    fi
  done
  if [ -z "$node_bin" ]; then
    echo "No directly executable Node satisfies ^20.19.0 or >=22.12.0. Set PI_ENV_TOOL_NODE." >&2
    exit 1
  fi
fi

PATH="$(dirname "$node_bin"):$PATH"
export PATH
exec "$node_bin" "$@"
