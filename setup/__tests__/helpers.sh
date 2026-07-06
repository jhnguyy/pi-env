#!/usr/bin/env bash
# Shared helpers for setup shell tests. Source from setup/__tests__/*.test.sh.

setup_test_root() {
  cd "$(dirname "${BASH_SOURCE[1]}")/../.." && pwd
}

ROOT="${ROOT:-$(setup_test_root)}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

node_bin() {
  # Resolve through the same policy used by setup/node-run so tests use the
  # repository-declared Node version instead of whichever /bin/node exists on
  # the host. The full test runner exports PI_ENV_TEST_NODE_BIN before tests
  # mutate HOME/PATH; standalone test execution resolves it on demand.
  if [ -n "${PI_ENV_TEST_NODE_BIN:-}" ] && [ -x "$PI_ENV_TEST_NODE_BIN" ]; then
    printf '%s\n' "$PI_ENV_TEST_NODE_BIN"
    return 0
  fi
  # shellcheck source=setup/node-runtime.sh
  . "$ROOT/setup/node-runtime.sh"
  pi_env_select_node_bin "$ROOT"
}

run_node() {
  "$ROOT/scripts/node-run.sh" "$@"
}

assert_eq() {
  local actual="$1" expected="$2" message="$3"
  [ "$actual" = "$expected" ] || fail "$message: expected '$expected', got '$actual'"
}

assert_file_contains() {
  local file="$1" expected="$2"
  grep -qF "$expected" "$file" || fail "$file does not contain: $expected"
}

assert_file_count() {
  local file="$1" pattern="$2" expected="$3" actual
  actual=$(grep -cF "$pattern" "$file" || true)
  assert_eq "$actual" "$expected" "$file copy count for $pattern"
}

with_temp_dir() {
  mktemp -d
}

make_executable() {
  local path="$1" body="$2"
  printf '%s\n' "$body" > "$path"
  chmod +x "$path"
}
