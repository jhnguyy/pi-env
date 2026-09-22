#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
SCRIPT="$ROOT/setup/apply-managed-settings.mjs"
MANAGED="$ROOT/setup/config/managed-settings.json"

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
  local settings="$1" repo="$2" managed="${3:-$MANAGED}" node
  node=$(node_bin)
  "$node" "$SCRIPT" "$settings" "$managed" "$repo"
}

test_applies_managed_settings_and_package_once() {
  local tmp settings managed repo first second
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  managed="$tmp/managed.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  cat > "$settings" <<'JSON'
{
  "defaultProvider": "anthropic",
  "packages": [
  ],
}
JSON
  printf '%s\n' '{"_comment_fixture":"ignore","fixtureManaged":{"enabled":true}}' > "$managed"

  first=$(apply_settings "$settings" "$repo" "$managed")
  second=$(apply_settings "$settings" "$repo" "$managed")

  [ "$first" = "updated" ] || fail "first run should update settings, got $first"
  [ "$second" = "unchanged" ] || fail "second run should be unchanged, got $second"
  [ "$(json_get "$settings" 's.defaultProvider')" = "anthropic" ] || fail "defaultProvider should be preserved"
  [ "$(json_get "$settings" 's.fixtureManaged.enabled')" = "true" ] || fail "managed settings should be applied"
  [ "$(json_get "$settings" 'Object.keys(s).some((key) => key.startsWith("_comment"))')" = "false" ] || fail "managed comments should not be written to user settings"
  [ "$(json_get "$settings" 's.packages.length')" = "1" ] || fail "package should be added exactly once"
  [ "$(resolved_package_path "$settings" 0)" = "$repo" ] || fail "package path should resolve to repo"

  rm -rf "$tmp"
}

test_preserves_unmanaged_retry_settings() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  cat > "$settings" <<'JSON'
{
  "retry": {
    "customLocalSetting": "keep-me",
    "provider": {
      "customProviderSetting": "keep-me-too"
    }
  }
}
JSON

  apply_settings "$settings" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.retry.customLocalSetting')" = "keep-me" ] || fail "unmanaged retry key should be preserved"
  [ "$(json_get "$settings" 's.retry.provider.customProviderSetting')" = "keep-me-too" ] || fail "unmanaged provider key should be preserved"

  rm -rf "$tmp"
}

test_preserves_enabled_pi_update() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  cat > "$settings" <<'JSON'
{
  "piUpdate": {
    "enabled": true
  }
}
JSON

  apply_settings "$settings" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.piUpdate.enabled')" = "true" ] || fail "piUpdate.enabled=true should be preserved"

  rm -rf "$tmp"
}

test_applies_to_missing_settings_file() {
  local tmp settings repo result
  tmp="$(with_temp_dir)"
  settings="$tmp/nested/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"

  result=$(apply_settings "$settings" "$repo")

  [ "$result" = "created" ] || fail "missing settings should be created, got $result"
  [ "$(resolved_package_path "$settings" 0)" = "$repo" ] || fail "created settings should include package"

  rm -rf "$tmp"
}

test_repairs_malformed_packages_setting() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  printf '%s\n' '{"packages": {"invalid": true}}' > "$settings"

  apply_settings "$settings" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.packages.length')" = "1" ] || fail "malformed packages should be repaired before registration"
  [ "$(resolved_package_path "$settings" 0)" = "$repo" ] || fail "repaired package path should resolve to repo"

  rm -rf "$tmp"
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

test_restores_settings_when_package_registration_fails() {
  local tmp settings repo before
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/missing-repo"
  printf '%s\n' '{"theme": "existing"}' > "$settings"
  before="$(cat "$settings")"

  if apply_settings "$settings" "$repo" >"$tmp/stdout" 2>"$tmp/stderr"; then
    fail "missing package path should fail"
  fi

  grep -Fq 'Path does not exist' "$tmp/stderr" || fail "package failure should retain native detail"
  [ "$(cat "$settings")" = "$before" ] || fail "package failure should restore settings"
  [ ! -s "$tmp/stdout" ] || fail "package failure should not report success"

  rm -rf "$tmp"
}

test_preserves_empty_settings_file_when_package_registration_fails() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/agent/settings.json"
  repo="$tmp/missing-repo"
  mkdir -p "$(dirname "$settings")"
  : > "$settings"

  if apply_settings "$settings" "$repo" >"$tmp/stdout" 2>"$tmp/stderr"; then
    fail "missing package path should fail for empty settings"
  fi

  [ -f "$settings" ] || fail "package failure should preserve an existing empty settings file"
  [ ! -s "$settings" ] || fail "restored empty settings file should stay empty"

  rm -rf "$tmp"
}

test_preserves_existing_theme() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  cat > "$settings" <<'JSON'
{
  "theme": "tokyonight"
}
JSON

  apply_settings "$settings" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.theme')" = "tokyonight" ] || fail "custom theme should be preserved"

  rm -rf "$tmp"
}

test_disables_default_extensions_without_clobbering_other_extensions() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  cat > "$settings" <<'JSON'
{
  "extensions": ["my-extension", "playwright-client", "extensions/playwright-client", "-playwright-client", "work-tracker", ".pi/extensions/work-tracker", "-work-tracker"]
}
JSON

  apply_settings "$settings" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.extensions')" = '["my-extension","-playwright-client","-work-tracker"]' ] || fail "setup should preserve other extensions and disable defaults once"

  rm -rf "$tmp"
}

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

  git -C "$repo" worktree remove -f "$worktree" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}

test_migrates_only_default_npm_command_to_nub() {
  local tmp settings custom_settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/default/settings.json"
  custom_settings="$tmp/custom/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo" "$(dirname "$settings")" "$(dirname "$custom_settings")"
  cat > "$settings" <<'JSON'
{
  "npmCommand": ["npm"]
}
JSON
  cat > "$custom_settings" <<'JSON'
{
  "npmCommand": ["npm", "--offline"]
}
JSON

  apply_settings "$settings" "$repo" >/dev/null
  apply_settings "$custom_settings" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.npmCommand')" = '["nub"]' ] || fail "default npmCommand should migrate to nub"
  [ "$(json_get "$custom_settings" 's.npmCommand')" = '["npm","--offline"]' ] || fail "custom npmCommand should be preserved"

  rm -rf "$tmp"
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

  rm -rf "$tmp"
}

test_applies_managed_settings_and_package_once
test_preserves_unmanaged_retry_settings
test_preserves_enabled_pi_update
test_applies_to_missing_settings_file
test_repairs_malformed_packages_setting
test_rejects_malformed_package_entry_before_writing
test_restores_settings_when_package_registration_fails
test_preserves_empty_settings_file_when_package_registration_fails
test_preserves_existing_theme
test_disables_default_extensions_without_clobbering_other_extensions
test_registers_primary_checkout_when_run_from_worktree
test_migrates_only_default_npm_command_to_nub
test_rejects_noncanonical_settings_filename

echo "managed settings tests passed"
