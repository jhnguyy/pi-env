#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
export PI_ENV_TEST_NODE_BIN="$(node_bin)"
"$PI_ENV_TEST_NODE_BIN" "$ROOT/setup/__tests__/configuration-e2e.mjs" "$@"
