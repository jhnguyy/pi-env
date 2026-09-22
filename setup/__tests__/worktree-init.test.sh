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
if [ "${1:-}" = "install" ]; then
  count=0
  [ ! -f "$NUB_COUNT" ] || count=$(cat "$NUB_COUNT")
  count=$((count + 1))
  printf "%s\n" "$count" > "$NUB_COUNT"
  if [ "$count" -le "${NUB_FAIL_INSTALLS:-0}" ]; then
    mkdir -p node_modules
    printf "%s\n" partial > node_modules/partial-install
    exit 1
  fi
fi
if [ "${1:-}" = run ]; then
  printf '%s\n' completed > "$NUB_VERIFY"
fi'
}

new_fixture() {
  TEMP=$(with_temp_dir)
  REPO="$TEMP/repo"
  BIN="$TEMP/bin"
  COUNT="$TEMP/nub.count"
  VERIFY="$TEMP/nub.verify"
  make_repo "$REPO"
  make_fake_nub "$BIN"
}

run_init() {
  local cwd="$1"
  shift
  (
    cd "$cwd"
    env PATH="$BIN:$PATH" NUB_COUNT="$COUNT" NUB_VERIFY="$VERIFY" "$@" \
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
  [ -e "$VERIFY" ] || fail "worktree initialization skipped install verification"
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

test_does_not_delete_or_retry_existing_dependencies_after_failed_install() {
  new_fixture
  mkdir -p "$REPO/node_modules"
  printf '%s\n' existing > "$REPO/node_modules/existing-sentinel"
  local status

  set +e
  run_init "$REPO" NUB_FAIL_INSTALLS=1 >/dev/null 2>&1
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail "worktree initialization retried a failed install over existing dependencies"
  assert_file_contains "$REPO/node_modules/existing-sentinel" 'existing'
  assert_eq "$(cat "$COUNT")" "1" "existing dependency install count"
  [ ! -e "$VERIFY" ] || fail "worktree initialization verified a failed install"
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
test_does_not_delete_or_retry_existing_dependencies_after_failed_install
test_reports_missing_nub

echo "worktree init tests passed"
