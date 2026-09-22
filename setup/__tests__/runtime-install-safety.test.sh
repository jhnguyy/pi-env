#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"

new_fixture() {
  TEMP=$(with_temp_dir)
  REPO="$TEMP/repo"
  BIN="$TEMP/bin"
  LOG="$TEMP/nub.log"
  mkdir -p "$REPO/scripts" "$BIN" "$TEMP/pi-bin"
  cp "$ROOT/scripts/check-nub-version.mjs" "$REPO/scripts/check-nub-version.mjs"
  cat > "$REPO/package.json" <<'JSON'
{ "packageManager": "nub@0.9.2", "devDependencies": { "@earendil-works/pi-coding-agent": "1.0.0" } }
JSON
  printf '%s\n' 'lockfileVersion: 1' > "$REPO/nub.lock"
  printf '%s\n' '// fixture patch helper' > "$REPO/scripts/patch-effect-language-service.mjs"
  make_executable "$REPO/scripts/restart-lsp-daemon.sh" '#!/usr/bin/env sh
exit 0'
  make_executable "$BIN/nub" '#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "--version" ]; then
  printf "v%s\n" "${NUB_VERSION:-0.9.2}"
  exit
fi
printf "%s\n" "$*" >> "$NUB_LOG"
case "${1:-}" in
  install)
    if [[ " $* " == *" --lockfile-only "* ]]; then
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
  env PATH="$BIN:$PATH" NUB_LOG="$LOG" NUB_COUNT="$TEMP/nub.count" REPO="$REPO" PI_BIN_DIR="$TEMP/pi-bin" \
    PI_ENV_CLI_MANAGED_BY_NIX=1 PI_ENV_CONFIG_MANAGED_BY_NIX=1 \
    "$@" "$(node_bin)" "$ROOT/setup/runtime.mjs" "$(node_bin)" all
}

finish_fixture() {
  rm -rf "$TEMP"
}

test_incompatible_nub_fails_before_touching_existing_dependencies() {
  new_fixture
  mkdir -p "$REPO/node_modules"
  printf '%s\n' existing > "$REPO/node_modules/existing-sentinel"
  local output status

  set +e
  output=$(run_runtime NUB_VERSION=0.2.10 2>&1)
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "runtime setup accepted an incompatible Nub"
  assert_file_contains "$REPO/node_modules/existing-sentinel" 'existing'
  [ ! -e "$TEMP/nub.count" ] || fail "runtime setup installed after a failed lock preflight"
  case "$output" in
    *'Nub 0.9.2 is required; found 0.2.10'*) ;;
    *) fail "runtime setup did not explain the incompatible Nub" ;;
  esac
  finish_fixture
}

test_preserves_existing_dependencies_after_failed_install() {
  new_fixture
  mkdir -p "$REPO/node_modules"
  printf '%s\n' existing > "$REPO/node_modules/existing-sentinel"
  local output status

  set +e
  output=$(run_runtime 2>&1)
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "runtime setup retried a failed install over existing dependencies"
  assert_file_contains "$REPO/node_modules/existing-sentinel" 'existing'
  assert_eq "$(cat "$TEMP/nub.count")" "1" "existing dependency install count"
  case "$output" in
    *'preserving existing node_modules without retry'*) ;;
    *) fail "runtime setup did not report dependency preservation" ;;
  esac
  finish_fixture
}

test_retries_once_after_cleaning_a_new_partial_tree() {
  new_fixture

  run_runtime NUB_FAIL_INSTALLS=1 NUB_REQUIRE_CLEAN_RETRY=1 >/dev/null

  assert_eq "$(cat "$TEMP/nub.count")" "2" "runtime retry install count"
  [ ! -e "$REPO/node_modules/partial-install" ] || fail "runtime retry retained partial dependencies"
  finish_fixture
}

test_missing_lock_fails_before_install_and_preserves_dependencies() {
  new_fixture
  rm "$REPO/nub.lock"
  mkdir -p "$REPO/node_modules"
  printf '%s\n' existing > "$REPO/node_modules/existing-sentinel"
  local output status

  set +e
  output=$(run_runtime 2>&1)
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "runtime setup accepted a missing lockfile"
  assert_file_contains "$REPO/node_modules/existing-sentinel" 'existing'
  [ ! -e "$LOG" ] || fail "runtime setup invoked Nub without a lockfile"
  case "$output" in
    *'missing committed nub.lock'*) ;;
    *) fail "runtime setup did not explain the missing lockfile" ;;
  esac
  finish_fixture
}

test_incompatible_nub_fails_before_touching_existing_dependencies
test_preserves_existing_dependencies_after_failed_install
test_retries_once_after_cleaning_a_new_partial_tree
test_missing_lock_fails_before_install_and_preserves_dependencies

echo "runtime install safety tests passed"
