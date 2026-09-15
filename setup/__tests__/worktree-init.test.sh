#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "$0")" && pwd)/helpers.sh"

make_repo() {
  git init -q "$1"
  mkdir -p "$1/nested/path" "$1/.git/hooks" "$1/dist"
  printf '%s\n' 'hook sentinel' > "$1/.git/hooks/pre-commit"
  printf '%s\n' 'dist sentinel' > "$1/dist/sentinel"
}

make_fake_nub() {
  mkdir -p "$1"
  make_executable "$1/nub" '#!/usr/bin/env bash
set -euo pipefail
printf "%s|%s\n" "$PWD" "$*" >> "$NUB_LOG"
if [ "${1:-}" = "install" ]; then
  count=0
  [ ! -f "$NUB_COUNT" ] || count=$(cat "$NUB_COUNT")
  count=$((count + 1))
  printf "%s\n" "$count" > "$NUB_COUNT"
  if [ "$count" -le "${NUB_FAIL_INSTALLS:-0}" ]; then
    if [ -n "${NUB_FAILURE_LINK_TARGET:-}" ]; then
      ln -s "$NUB_FAILURE_LINK_TARGET" node_modules
    else
      mkdir -p node_modules
      printf "%s\n" partial > node_modules/partial-install
    fi
    exit 1
  fi
  if [ "$count" -gt 1 ] && [ "${NUB_REQUIRE_CLEAN_RETRY:-0}" = 1 ] && [ -e node_modules/partial-install ]; then
    echo "retry kept partial node_modules" >&2
    exit 9
  fi
fi'
}

new_fixture() {
  TEMP=$(with_temp_dir)
  REPO="$TEMP/repo"
  BIN="$TEMP/bin"
  LOG="$TEMP/nub.log"
  COUNT="$TEMP/nub.count"
  make_repo "$REPO"
  make_fake_nub "$BIN"
}

run_init() {
  local cwd="$1"
  shift
  (
    cd "$cwd"
    env PATH="$BIN:$PATH" NUB_LOG="$LOG" NUB_COUNT="$COUNT" "$@" \
      bash "$ROOT/scripts/init-worktree.sh"
  )
}

assert_sentinels_unchanged() {
  assert_file_contains "$REPO/.git/hooks/pre-commit" 'hook sentinel'
  assert_file_contains "$REPO/dist/sentinel" 'dist sentinel'
}

finish_fixture() {
  assert_sentinels_unchanged
  rm -rf "$TEMP"
}

test_initializes_from_nested_cwd_without_sharing_dependencies() {
  new_fixture
  local shared="$TEMP/shared-node-modules"
  mkdir -p "$shared"
  ln -s "$shared" "$REPO/node_modules"

  run_init "$REPO/nested/path" >/dev/null

  [ ! -L "$REPO/node_modules" ] || fail "worktree kept a shared node_modules symlink"
  assert_eq "$(cat "$LOG")" "$REPO|install --frozen-lockfile
$REPO|run verify:install" "worktree initialization command sequence"
  assert_eq "$(cat "$COUNT")" "1" "successful install count"
  finish_fixture
}

test_keeps_a_local_dependency_tree_after_success() {
  new_fixture
  mkdir -p "$REPO/node_modules"
  printf '%s\n' local > "$REPO/node_modules/local-sentinel"

  run_init "$REPO" >/dev/null

  assert_file_contains "$REPO/node_modules/local-sentinel" 'local'
  assert_eq "$(cat "$COUNT")" "1" "local dependency install count"
  finish_fixture
}

test_retries_once_after_removing_partial_install() {
  new_fixture

  run_init "$REPO" NUB_FAIL_INSTALLS=1 NUB_REQUIRE_CLEAN_RETRY=1 >/dev/null 2>&1

  assert_eq "$(cat "$COUNT")" "2" "retried install count"
  assert_file_count "$LOG" 'install --frozen-lockfile' 2
  assert_file_count "$LOG" 'run verify:install' 1
  finish_fixture
}

test_preserves_a_shared_target_created_by_a_failed_install() {
  new_fixture
  local shared="$TEMP/shared-node-modules"
  mkdir -p "$shared"
  printf '%s\n' shared > "$shared/shared-sentinel"

  run_init "$REPO" NUB_FAIL_INSTALLS=1 NUB_FAILURE_LINK_TARGET="$shared" >/dev/null 2>&1

  assert_file_contains "$shared/shared-sentinel" 'shared'
  [ ! -L "$REPO/node_modules" ] || fail "retry kept a shared node_modules symlink"
  assert_eq "$(cat "$COUNT")" "2" "symlink cleanup retry count"
  finish_fixture
}

test_fails_after_one_retry_without_verifying() {
  new_fixture
  local output status

  set +e
  output=$(run_init "$REPO" NUB_FAIL_INSTALLS=2 2>&1)
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "worktree initialization succeeded after two failed installs"
  assert_eq "$(cat "$COUNT")" "2" "failed install count"
  assert_file_count "$LOG" 'run verify:install' 0
  case "$output" in
    *'Nub install failed after the retry.'*) ;;
    *) fail "retry failure did not explain the Nub install failure" ;;
  esac
  finish_fixture
}

test_reports_missing_nub() {
  new_fixture
  local no_nub_bin="$TEMP/no-nub-bin" output status
  mkdir -p "$no_nub_bin"
  ln -s "$(command -v git)" "$no_nub_bin/git"

  set +e
  output=$(cd "$REPO" && PATH="$no_nub_bin" /bin/bash "$ROOT/scripts/init-worktree.sh" 2>&1)
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "worktree initialization succeeded without Nub"
  case "$output" in
    *'Nub is required'*) ;;
    *) fail "missing Nub failure was not clear" ;;
  esac
  finish_fixture
}

test_initializes_from_nested_cwd_without_sharing_dependencies
test_keeps_a_local_dependency_tree_after_success
test_retries_once_after_removing_partial_install
test_preserves_a_shared_target_created_by_a_failed_install
test_fails_after_one_retry_without_verifying
test_reports_missing_nub

echo "worktree init tests passed"
