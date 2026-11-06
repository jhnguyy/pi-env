#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"

test_failed_install_does_not_delete_or_retry() {
  local temp repo bin output status=0
  temp=$(with_temp_dir)
  repo="$temp/repo"
  bin="$temp/bin"
  mkdir -p "$repo/node_modules" "$bin" "$temp/pi-bin"
  printf '%s\n' existing > "$repo/node_modules/existing-sentinel"
  make_executable "$bin/nub" '#!/bin/sh
if [ "$1" = install ]; then
  echo "call: nub install" >&2
  printf partial > node_modules/partial-install
  exit 1
fi'

  output=$(PATH="$bin:$PATH" REPO="$repo" PI_BIN_DIR="$temp/pi-bin" \
    PI_ENV_CLI_MANAGED_BY_NIX=1 PI_ENV_CONFIG_MANAGED_BY_NIX=1 \
    "$(node_bin)" "$ROOT/setup/runtime.mjs" "$(node_bin)" dependencies 2>&1) || status=$?

  [ "$status" -ne 0 ] || fail "runtime setup accepted a failed Nub install"
  assert_file_contains "$repo/node_modules/existing-sentinel" existing
  assert_eq "$(grep -c '^call: nub install$' <<<"$output")" "1" "runtime install attempt count"
}

test_failed_install_does_not_delete_or_retry

echo "runtime install safety tests passed"
