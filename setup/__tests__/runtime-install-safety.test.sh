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

test_install_has_one_hydration_owner() {
  local temp repo bin strategy
  temp=$(with_temp_dir)
  repo="$temp/repo"
  bin="$temp/bin"
  mkdir -p "$repo/scripts" "$repo/node_modules/@earendil-works/pi-coding-agent/dist" "$bin" "$temp/pi-bin"
  printf '%s\n' '{"devDependencies":{"@earendil-works/pi-coding-agent":"1.0.2"}}' > "$repo/package.json"
  printf '%s\n' '{"name":"@earendil-works/pi-coding-agent","version":"1.0.2","bin":{"pi":"dist/cli.js"}}' > "$repo/node_modules/@earendil-works/pi-coding-agent/package.json"
  : > "$repo/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  cat > "$repo/scripts/hydrate.mjs" <<'JS'
import fs from 'node:fs';
fs.appendFileSync(process.env.TRACE, `hydrate ${process.argv[2]}\n`);
JS
  make_executable "$bin/nub" '#!/usr/bin/env bash
set -eu
printf "nub %s\n" "$*" >> "$TRACE"
if [ "$1" = install ]; then
  if [ "$STRATEGY" = normal ]; then
    "$TEST_NODE" scripts/hydrate.mjs "$TEST_NODE"
  fi
elif [ "$STRATEGY" = fallback ] && [[ "$*" != *--ignore-scripts* ]]; then
  exit 1
fi'
  for strategy in normal fallback; do
    TRACE="$temp/$strategy.trace" STRATEGY="$strategy" TEST_NODE="$(node_bin)" PATH="$bin:$PATH" \
      REPO="$repo" PI_BIN_DIR="$temp/pi-bin" PI_ENV_CLI_MANAGED_BY_NIX=1 \
      "$(node_bin)" "$ROOT/setup/runtime.mjs" "$(node_bin)" all >"$temp/$strategy.log" 2>&1
    assert_file_count "$temp/$strategy.trace" "hydrate $(node_bin)" 1
    assert_file_count "$temp/$strategy.trace" 'nub install' 1
    assert_file_contains "$temp/$strategy.trace" 'frozen-lockfile'
    if grep -Eq 'nub run build|restart-lsp|build-extensions|patch-effect' "$temp/$strategy.trace"; then
      fail "🤖: setup duplicated hydration work"
    fi
  done
  assert_file_contains "$temp/fallback.trace" 'nub install --ignore-scripts --frozen-lockfile'
  rm -rf "$temp"
}

test_failed_install_does_not_delete_or_retry
test_install_has_one_hydration_owner

echo "🤖: runtime install safety tests passed"
