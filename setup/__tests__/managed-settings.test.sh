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

}

# This boundary needs an isolated worktree rather than provisioning a second checkout.
test_registers_primary_checkout_when_run_from_worktree() {
  local tmp settings repo worktree result
  tmp="$(with_temp_dir)"
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
  [ "$result" = "updated" ] || fail "worktree run should update package registration, got $result"
  [ "$(json_get "$settings" 's.packages.length')" = "1" ] || fail "worktree package registration should dedupe to one package"
  [ "$(resolved_package_path "$settings" 0)" = "$repo" ] || fail "worktree setup should register primary checkout"
}

test_worktree_filters_migrate_with_primary_precedence() {
  local tmp repo worktree settings node
  tmp="$(with_temp_dir)"
  repo="$tmp/repo"
  worktree="$tmp/worktree"
  settings="$tmp/settings.json"
  node=$(node_bin)
  git init -q "$repo"
  git -C "$repo" -c user.name=Test -c user.email=test@example.invalid commit --allow-empty -qm init
  git -C "$repo" worktree add -qb filters "$worktree"

  "$node" --input-type=module - "$SCRIPT" "$settings" "$repo" "$worktree" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [script, settings, repo, worktree] = process.argv.slice(2);
const worktreeEntry = { source: worktree, extensions: ['!.pi/extensions/disabled.ts'],
  skills: ['+.agents/skills/selected'], themes: [], prompts: ['prompts/keep.md'] };
const primaryEntry = { source: repo, extensions: [], skills: ['skills/primary'], themes: ['themes/primary.json'] };
const migrated = { ...worktreeEntry, source: repo, extensions: ['!extensions/disabled.ts'],
  skills: ['+skills/selected'] };
const apply = () => execFileSync(process.execPath, [script, settings, worktree], { encoding: 'utf8' });
const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
const normalize = (entry) => ({ ...entry, source: path.resolve(path.dirname(settings), entry.source) });
for (const [packages, expected] of [
  [[worktreeEntry], migrated],
  [[worktreeEntry, primaryEntry], primaryEntry],
  [[primaryEntry, worktreeEntry], primaryEntry],
  [[worktreeEntry, repo], repo],
]) {
  fs.writeFileSync(settings, JSON.stringify({ packages }));
  apply();
  const actual = read().packages;
  assert.equal(actual.length, 1);
  if (typeof expected === 'string') assert.equal(path.resolve(path.dirname(settings), actual[0]), expected);
  else {
    assert.equal(typeof actual[0], 'object', 'worktree resource filters must remain an object');
    assert.deepEqual(normalize(actual[0]), expected);
  }
  const before = fs.readFileSync(settings, 'utf8');
  assert.equal(apply().trim(), 'unchanged');
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
}
JS
}

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

}

test_rejects_malformed_package_entry_before_writing
test_registers_primary_checkout_when_run_from_worktree
test_worktree_filters_migrate_with_primary_precedence
test_rejects_noncanonical_settings_filename
echo "settings registration tests passed"
