#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
NODE=$(node_bin)
TEMP=$(with_temp_dir)
export PI_ENV_REPO="$ROOT"
mkdir -p "$TEMP/bin"

assert_eq "$(PI_ENV_NODE_BIN="$NODE" "$ROOT/scripts/node-run.sh" -e 'console.log("runtime-ready")')" \
  runtime-ready 'provisioned runtime executes scripts'

# Missing-runtime failures require injection rather than changing a real provisioner/cache.
if PI_ENV_NODE_BIN="$TEMP/missing-node" "$ROOT/scripts/node-run.sh" -e 'console.log("unexpected")' >/dev/null 2>&1; then
  fail 'an unusable provisioned runtime must not silently select another installation'
fi
make_executable "$TEMP/bin/nub" "#!/bin/sh
printf '%s\\n' '$TEMP/missing-node'"
if PI_ENV_NODE_BIN= NODE_EXECUTABLE= PI_ENV_SETUP_MODE=portable PI_ENV_CONFIG_MANAGED_BY_NIX=0 PATH="$TEMP/bin:$PATH" \
  "$ROOT/scripts/node-run.sh" -e 'console.log("unexpected")' >/dev/null 2>&1; then
  fail 'an unusable Nub runtime must fail rather than search unrelated installations'
fi

make_executable "$TEMP/tool-node" '#!/bin/sh
if [ "$1" = -p ]; then printf "22.12.0\n"; else printf "tool:%s\n" "$*"; fi'
assert_eq "$(PI_ENV_TOOL_NODE="$TEMP/tool-node" "$ROOT/scripts/tool-node-run.sh" launcher --check)" \
  'tool:launcher --check' 'native-tool adapter runs the tool'
cp "$TEMP/tool-node" "$TEMP/tool node"
assert_eq "$(PI_ENV_TOOL_NODE="$TEMP/tool node" "$ROOT/scripts/tool-node-run.sh" launcher --check)" \
  'tool:launcher --check' 'native-tool adapter preserves executable paths containing spaces'
make_executable "$TEMP/tool-node" '#!/bin/sh
printf "22.11.0\n"'
status=0
output=$(PI_ENV_TOOL_NODE="$TEMP/tool-node" "$ROOT/scripts/tool-node-run.sh" launcher 2>&1) || status=$?
[ "$status" -ne 0 ] || fail 'native-tool adapter must reject an unsupported host runtime'
grep -qF 'must be executable and satisfy' <<<"$output" || fail "unsupported runtime error should explain the requirement (got: $output)"
echo "node resolution tests passed"
