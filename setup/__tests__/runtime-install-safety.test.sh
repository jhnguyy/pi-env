#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"

test_failed_install_does_not_delete_or_retry() {
  local temp repo bin count status
  temp=$(with_temp_dir)
  repo="$temp/repo"
  bin="$temp/bin"
  count="$temp/install.count"
  mkdir -p "$repo/node_modules" "$bin" "$temp/pi-bin"
  printf '%s\n' existing > "$repo/node_modules/existing-sentinel"
  make_executable "$bin/nub" '#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = install ]; then
  count=0
  [ ! -f "$NUB_COUNT" ] || count=$(cat "$NUB_COUNT")
  count=$((count + 1))
  printf "%s\n" "$count" > "$NUB_COUNT"
  printf partial > node_modules/partial-install
  exit 1
fi
exit 0'

  set +e
  PATH="$bin:$PATH" NUB_COUNT="$count" REPO="$repo" PI_BIN_DIR="$temp/pi-bin" \
    PI_ENV_CLI_MANAGED_BY_NIX=1 PI_ENV_CONFIG_MANAGED_BY_NIX=1 \
    "$(node_bin)" "$ROOT/setup/runtime.mjs" "$(node_bin)" all >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "runtime setup accepted a failed Nub install"
  assert_file_contains "$repo/node_modules/existing-sentinel" existing
  assert_eq "$(cat "$count")" "1" "runtime install attempt count"
  rm -rf "$temp"
}

test_failed_install_does_not_delete_or_retry

echo "runtime install safety tests passed"
