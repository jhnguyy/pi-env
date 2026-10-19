#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
"$(node_bin)" "$ROOT/setup/__tests__/themes.workflow.mjs"
