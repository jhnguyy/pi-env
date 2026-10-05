#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
source "$ROOT/setup/node-runtime.sh"

NODE=$(node_bin)
output=$(PI_ENV_NODE_BIN="$NODE" "$ROOT/scripts/node-run.sh" -e 'console.log(process.argv[1])' ok)
assert_eq "$output" ok 'provisioned runtime executes scripts'
TEMP=$(with_temp_dir)
mkdir -p "$TEMP/bin" "$TEMP/repo"
trap 'rm -rf "$TEMP"' EXIT
make_executable "$TEMP/node" '#!/bin/sh
exit 0'
make_executable "$TEMP/broken" '#!/bin/sh
exit 127'
make_executable "$TEMP/bin/nub" "#!/bin/sh
[ \"\$1 \$2\" = 'node which' ] || exit 1
printf '%s\\n' '$TEMP/node'"

selected=$(PI_ENV_NODE_BIN= NODE_EXECUTABLE= PI_ENV_SETUP_MODE=portable PI_ENV_CONFIG_MANAGED_BY_NIX=0 PATH="$TEMP/bin:$PATH" pi_env_select_node_bin "$TEMP/repo")
assert_eq "$selected" "$TEMP/node" 'portable mode delegates runtime selection to Nub'
selected=$(PI_ENV_NODE_BIN= NODE_EXECUTABLE="$TEMP/node" PI_ENV_SETUP_MODE=nix-managed PI_ENV_CONFIG_MANAGED_BY_NIX=1 pi_env_select_node_bin "$TEMP/repo")
assert_eq "$selected" "$TEMP/node" 'Nix mode consumes its provisioned runtime'
if PI_ENV_NODE_BIN="$TEMP/broken" pi_env_select_node_bin "$TEMP/repo" >"$TEMP/output" 2>&1; then
  fail 'broken provisioned runtime must not silently select another installation'
fi
assert_file_contains "$TEMP/output" 'package.json#engines.node'
make_executable "$TEMP/bin/nub" "#!/bin/sh
printf '%s\\n' '$TEMP/broken'"
if PI_ENV_NODE_BIN= NODE_EXECUTABLE= PI_ENV_SETUP_MODE=portable PI_ENV_CONFIG_MANAGED_BY_NIX=0 PATH="$TEMP/bin:$PATH" pi_env_select_node_bin "$TEMP/repo" >"$TEMP/output" 2>&1; then
  fail 'broken Nub runtime must fail rather than search unrelated installations'
fi

make_executable "$TEMP/tool-node" '#!/bin/sh
if [ "$1" = -p ]; then printf "22.12.0\n"; else printf "tool:%s\n" "$*"; fi'
output=$(PI_ENV_TOOL_NODE="$TEMP/tool-node" "$ROOT/scripts/tool-node-run.sh" launcher --check)
assert_eq "$output" 'tool:launcher --check' 'native-tool adapter retains its direct executable contract'
make_executable "$TEMP/tool-node" '#!/bin/sh
printf "22.11.0\n"'
if PI_ENV_TOOL_NODE="$TEMP/tool-node" "$ROOT/scripts/tool-node-run.sh" launcher >"$TEMP/output" 2>&1; then
  fail 'native-tool adapter must reject an unsupported host runtime'
fi
assert_file_contains "$TEMP/output" 'must be executable and satisfy'
echo 'Node provisioning tests passed'
