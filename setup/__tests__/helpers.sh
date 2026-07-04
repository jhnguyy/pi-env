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
  if [ -n "${PI_ENV_NODE_BIN:-}" ] && [ -x "$PI_ENV_NODE_BIN" ]; then
    printf '%s\n' "$PI_ENV_NODE_BIN"
  elif [ -x /bin/node ]; then
    printf '%s\n' /bin/node
  else
    command -v node
  fi
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
