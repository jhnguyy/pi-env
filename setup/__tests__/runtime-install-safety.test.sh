#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"

new_fixture() {
  TEMP=$(with_temp_dir)
  REPO="$TEMP/repo"
  BIN="$TEMP/bin"
  LOG="$TEMP/nub.log"
  PREFLIGHT="$TEMP/nub.preflight"
  mkdir -p "$REPO/scripts" "$BIN" "$TEMP/pi-bin"
  cat > "$REPO/package.json" <<'JSON'
{ "devDependencies": { "@earendil-works/pi-coding-agent": "1.0.0" } }
JSON
  printf '%s\n' 'lockfileVersion: 1' > "$REPO/nub.lock"
  printf '%s\n' '// fixture patch helper' > "$REPO/scripts/patch-effect-language-service.mjs"
  make_executable "$REPO/scripts/restart-lsp-daemon.sh" '#!/usr/bin/env sh
exit 0'
  make_executable "$BIN/nub" '#!/usr/bin/env bash
set -euo pipefail
printf "%s\n" "$*" >> "$NUB_LOG"
case "${1:-}" in
  install)
    if [[ " $* " == *" --lockfile-only "* ]]; then
      printf '%s\n' attempted > "$NUB_PREFLIGHT"
      [ "${NUB_FAIL_PREFLIGHT:-0}" = 0 ]
      exit
    fi
    count=0
    [ ! -f "$NUB_COUNT" ] || count=$(cat "$NUB_COUNT")
    count=$((count + 1))
    printf "%s\n" "$count" > "$NUB_COUNT"
    if [ "$count" -le "${NUB_FAIL_INSTALLS:-1}" ]; then
      mkdir -p node_modules
      printf partial > node_modules/partial-install
      exit 1
    fi
    if [ "${NUB_REQUIRE_CLEAN_RETRY:-0}" = 1 ] && [ -e node_modules/partial-install ]; then exit 9; fi
    mkdir -p node_modules/@earendil-works/pi-coding-agent/dist
    printf "{\"bin\":{\"pi\":\"dist/cli.js\"}}\n" > node_modules/@earendil-works/pi-coding-agent/package.json
    : > node_modules/@earendil-works/pi-coding-agent/dist/cli.js
    ;;
  run) exit 0 ;;
esac'
}

run_runtime() {
  env PATH="$BIN:$PATH" NUB_LOG="$LOG" NUB_COUNT="$TEMP/nub.count" NUB_PREFLIGHT="$PREFLIGHT" REPO="$REPO" PI_BIN_DIR="$TEMP/pi-bin" \
    PI_ENV_CLI_MANAGED_BY_NIX=1 PI_ENV_CONFIG_MANAGED_BY_NIX=1 \
    "$@" "$(node_bin)" "$ROOT/setup/runtime.mjs" "$(node_bin)" all
}

finish_fixture() {
  rm -rf "$TEMP"
}

test_lock_preflight_failure_does_not_install_or_remove_existing_dependencies() {
  new_fixture
  mkdir -p "$REPO/node_modules"
  printf '%s\n' existing > "$REPO/node_modules/existing-sentinel"
  local status

  set +e
  run_runtime NUB_FAIL_PREFLIGHT=1 >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "runtime setup accepted an incompatible lockfile"
  assert_file_contains "$REPO/node_modules/existing-sentinel" 'existing'
  [ -e "$PREFLIGHT" ] || fail "runtime setup did not exercise lock compatibility admission"
  [ ! -e "$TEMP/nub.count" ] || fail "runtime setup installed after lock compatibility admission failed"
  finish_fixture
}

test_does_not_delete_or_retry_existing_dependencies_after_failed_install() {
  new_fixture
  mkdir -p "$REPO/node_modules"
  printf '%s\n' existing > "$REPO/node_modules/existing-sentinel"
  local status

  set +e
  run_runtime >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "runtime setup retried a failed install over existing dependencies"
  assert_file_contains "$REPO/node_modules/existing-sentinel" 'existing'
  assert_eq "$(cat "$TEMP/nub.count")" "1" "existing dependency install count"
  finish_fixture
}

test_retries_once_after_cleaning_a_new_partial_tree() {
  new_fixture

  run_runtime NUB_FAIL_INSTALLS=1 NUB_REQUIRE_CLEAN_RETRY=1 >/dev/null

  assert_eq "$(cat "$TEMP/nub.count")" "2" "runtime retry install count"
  [ ! -e "$REPO/node_modules/partial-install" ] || fail "runtime retry retained partial dependencies"
  finish_fixture
}

test_lock_preflight_failure_does_not_install_or_remove_existing_dependencies
test_does_not_delete_or_retry_existing_dependencies_after_failed_install
test_retries_once_after_cleaning_a_new_partial_tree

echo "runtime install safety tests passed"
