#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
NODE=$(node_bin)
TEMP=$(with_temp_dir)
printf 'Node adapter evidence: %s\n' "$TEMP"
phase=initialization
finish() {
  local status=$?
  DIR="$TEMP" STATUS="$status" PHASE="$phase" "$NODE" --input-type=module <<'JS'
import fs from 'node:fs';
fs.writeFileSync(`${process.env.DIR}/result.json`, JSON.stringify({
  inputs: 'real provisioned Node; missing selected runtimes; inherited native-tool probes',
  expected: 'scripts execute; unusable selected runtimes fail without fallback; native-tool adapter boundary remains intact',
  actual: {phase: process.env.PHASE, exitStatus: Number(process.env.STATUS)},
  verdict: process.env.STATUS === '0' ? 'pass' : 'fail',
  reproduce: 'bash setup/__tests__/node-resolution.test.sh', inspect: 'result.json and *.log',
}, null, 2) + '\n');
JS
  exit "$status"
}
trap finish EXIT
export PI_ENV_REPO="$ROOT"
mkdir -p "$TEMP/bin"
phase='provisioned runtime execution'
PI_ENV_NODE_BIN="$NODE" "$ROOT/scripts/node-run.sh" -e 'console.log("runtime-ready")' >"$TEMP/provisioned.log" 2>&1
assert_file_contains "$TEMP/provisioned.log" runtime-ready
# Missing-runtime failures require injection rather than changing a real provisioner/cache.
phase='unavailable provisioned runtime'
if PI_ENV_NODE_BIN="$TEMP/missing-node" "$ROOT/scripts/node-run.sh" -e 'console.log("unexpected execution")' >"$TEMP/provisioned-failure.log" 2>&1; then
  fail 'an unusable provisioned runtime must not silently select another installation'
fi
phase='unavailable Nub-selected runtime'
make_executable "$TEMP/bin/nub" "#!/bin/sh
printf '%s\\n' '$TEMP/missing-node'"
if PI_ENV_NODE_BIN= NODE_EXECUTABLE= PI_ENV_SETUP_MODE=portable PI_ENV_CONFIG_MANAGED_BY_NIX=0 PATH="$TEMP/bin:$PATH" "$ROOT/scripts/node-run.sh" -e 'console.log("unexpected execution")' >"$TEMP/portable-failure.log" 2>&1; then
  fail 'an unusable Nub runtime must fail rather than search unrelated installations'
fi
phase='native-tool adapter'
make_executable "$TEMP/tool-node" '#!/bin/sh
if [ "$1" = -p ]; then printf "22.12.0\n"; else printf "tool:%s\n" "$*"; fi'
PI_ENV_TOOL_NODE="$TEMP/tool-node" "$ROOT/scripts/tool-node-run.sh" launcher --check >"$TEMP/native-tool.log" 2>&1
assert_file_contains "$TEMP/native-tool.log" 'tool:launcher --check'
make_executable "$TEMP/tool-node" '#!/bin/sh
printf "22.11.0\n"'
if PI_ENV_TOOL_NODE="$TEMP/tool-node" "$ROOT/scripts/tool-node-run.sh" launcher >"$TEMP/native-tool-failure.log" 2>&1; then
  fail 'native-tool adapter must reject an unsupported host runtime'
fi
assert_file_contains "$TEMP/native-tool-failure.log" 'must be executable and satisfy'
phase=complete
