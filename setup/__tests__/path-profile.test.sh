#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=setup/lib.sh
source "$ROOT/setup/lib.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1" expected="$2"
  grep -qF "$expected" "$file" || fail "$file does not contain: $expected"
}

assert_count() {
  local file="$1" pattern="$2" expected="$3" actual
  actual=$(grep -cF "$pattern" "$file" || true)
  [ "$actual" = "$expected" ] || fail "$file has $actual copies of $pattern; expected $expected"
}

test_creates_profile_when_no_shell_profile_exists() {
  local old_home="$HOME" tmp_home
  tmp_home="$(mktemp -d)"
  HOME="$tmp_home"

  ensure_path_in_shell_profiles "$HOME/.local/bin" >/dev/null

  assert_contains "$HOME/.profile" 'export PATH="$HOME/.local/bin:$PATH"'
  HOME="$old_home"
  rm -rf "$tmp_home"
}

test_updates_existing_profiles_once() {
  local old_home="$HOME" tmp_home profile
  tmp_home="$(mktemp -d)"
  HOME="$tmp_home"
  for profile in .zshrc .bashrc .profile; do
    printf '# existing %s\n' "$profile" > "$HOME/$profile"
  done

  ensure_path_in_shell_profiles "$HOME/.local/bin" >/dev/null
  ensure_path_in_shell_profiles "$HOME/.local/bin" >/dev/null

  for profile in .zshrc .bashrc .profile; do
    assert_count "$HOME/$profile" '# pi-env: add user-local bin to PATH' 1
    assert_count "$HOME/$profile" 'export PATH="$HOME/.local/bin:$PATH"' 1
  done
  HOME="$old_home"
  rm -rf "$tmp_home"
}

test_skips_existing_local_bin_export() {
  local old_home="$HOME" tmp_home
  tmp_home="$(mktemp -d)"
  HOME="$tmp_home"
  printf 'export PATH="$HOME/.local/bin:$PATH"\n' > "$HOME/.zshrc"

  ensure_path_in_shell_profiles "$HOME/.local/bin" >/dev/null

  assert_count "$HOME/.zshrc" '.local/bin' 1
  if grep -qF '# pi-env: add user-local bin to PATH' "$HOME/.zshrc"; then
    fail '.zshrc should not get a pi-env marker when an existing PATH entry is present'
  fi
  HOME="$old_home"
  rm -rf "$tmp_home"
}

test_creates_profile_when_no_shell_profile_exists
test_updates_existing_profiles_once
test_skips_existing_local_bin_export

echo "path profile tests passed"
