#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
SCRIPT="$ROOT/setup/apply-managed-settings.mjs"

json_get() {
  local file="$1" expr="$2" node
  node=$(node_bin)
  "$node" -e "const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const value = $expr; console.log(Array.isArray(value) ? JSON.stringify(value) : value);" "$file"
}

resolved_package_path() {
  local file="$1" index="$2" node
  node=$(node_bin)
  "$node" -e "const fs = require('fs'); const path = require('path'); const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(path.resolve(path.dirname(process.argv[1]), s.packages[Number(process.argv[2])]));" "$file" "$index"
}

apply_settings() {
  local settings="$1" repo="$2" mode="${3:-}" node
  node=$(node_bin)
  "$node" "$SCRIPT" "$settings" "$repo" ${mode:+"$mode"}
}

test_rejects_malformed_package_entry_before_writing() {
  local tmp settings repo before
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  printf '%s\n' '{"packages": [null], "theme": "existing"}' > "$settings"
  before="$(cat "$settings")"

  if apply_settings "$settings" "$repo" >"$tmp/stdout" 2>"$tmp/stderr"; then
    fail "malformed package entry should fail"
  fi

  if ! grep -Fq 'settings.packages[0] must be a string or an object with a string source' "$tmp/stderr"; then
    fail "malformed package failure should identify the entry"
  fi
  [ "$(cat "$settings")" = "$before" ] || fail "malformed package failure should not rewrite settings"
  [ ! -s "$tmp/stdout" ] || fail "malformed package failure should not report success"

  rm -rf "$tmp"
}

# This boundary needs an isolated worktree rather than provisioning a second checkout.
test_registers_primary_checkout_when_run_from_worktree() (
  local tmp settings repo worktree result node
  tmp="$(with_temp_dir)"
  node=$(node_bin)
  printf 'Worktree registration evidence: %s\n' "$tmp"
  record_result() {
    local status=$?
    DIR="$tmp" STATUS="$status" "$node" --input-type=module <<'JS'
import fs from 'node:fs';
fs.writeFileSync(`${process.env.DIR}/result.json`, JSON.stringify({
  inputs: 'temporary primary checkout, worktree, and user settings',
  expected: 'registration canonicalizes to the primary checkout without duplicate packages',
  actual: {exitStatus: Number(process.env.STATUS)}, verdict: process.env.STATUS === '0' ? 'pass' : 'fail',
  reproduce: 'bash setup/__tests__/managed-settings.test.sh', inspect: 'normal.json, repo/, worktree/',
}, null, 2) + '\n');
JS
  }
  trap record_result EXIT
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  worktree="$tmp/worktree"
  mkdir -p "$repo"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.invalid
  git -C "$repo" config user.name 'pi-env test'
  touch "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m init
  git -C "$repo" worktree add -q "$worktree" -b feature/test
  cat > "$settings" <<JSON
{
  "packages": ["$worktree"]
}
JSON

  result=$(apply_settings "$settings" "$worktree")
  cp "$settings" "$tmp/normal.json"
  [ "$result" = "updated" ] || fail "worktree run should update package registration, got $result"
  [ "$(json_get "$settings" 's.packages.length')" = "1" ] || fail "worktree package registration should dedupe to one package"
  [ "$(resolved_package_path "$settings" 0)" = "$repo" ] || fail "worktree setup should register primary checkout"
)

test_rejects_noncanonical_settings_filename() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/custom-settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  printf '%s\n' '{}' > "$settings"

  if apply_settings "$settings" "$repo" >"$tmp/stdout" 2>"$tmp/stderr"; then
    fail "noncanonical settings filename should fail"
  fi

  if ! grep -Fq 'settings file must be named settings.json' "$tmp/stderr"; then
    fail "filename failure should explain the native settings boundary"
  fi
  [ "$(cat "$settings")" = '{}' ] || fail "filename failure should not rewrite settings"
  [ ! -e "$tmp/settings.json" ] || fail "filename failure should not write a sibling settings file"

  rm -rf "$tmp"
}

test_rejects_malformed_package_entry_before_writing
test_registers_primary_checkout_when_run_from_worktree
test_rejects_noncanonical_settings_filename
echo "settings registration tests passed"
