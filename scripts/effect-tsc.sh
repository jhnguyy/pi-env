#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Resolve in this checkout without changing the caller's supervision scope.
compiler="$(cd "$repo" && node \
  "$repo/node_modules/@effect/tsgo/dist/effect-tsgo.cjs" get-exe-path)"
exec node "$repo/scripts/run-supervised-node.mjs" \
  --heavyweight --command "$compiler" "$@"
