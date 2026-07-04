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

apply_settings() {
  local settings="$1" repo="$2" node
  node=$(node_bin)
  "$node" "$SCRIPT" "$settings" "$MANAGED" "$repo"
}

test_applies_managed_settings_and_package_once() {
  local tmp settings repo first second
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  cat > "$settings" <<'JSON'
{
  "defaultProvider": "anthropic",
  "packages": [
  ],
}
JSON

  first=$(apply_settings "$settings" "$repo")
  second=$(apply_settings "$settings" "$repo")

  [ "$first" = "updated" ] || fail "first run should update settings, got $first"
  [ "$second" = "unchanged" ] || fail "second run should be unchanged, got $second"
  [ "$(json_get "$settings" 's.defaultProvider')" = "anthropic" ] || fail "defaultProvider should be preserved"
  [ "$(json_get "$settings" 's.retry.enabled')" = "true" ] || fail "retry.enabled should be true"
  [ "$(json_get "$settings" 's.retry.provider.timeoutMs')" = "20000" ] || fail "provider timeout should be 20000"
  [ "$(json_get "$settings" 's.retry.provider.maxRetries')" = "1" ] || fail "provider retries should be 1"
  [ "$(json_get "$settings" 's.piUpdate.enabled')" = "false" ] || fail "piUpdate should default to disabled"
  [ "$(json_get "$settings" 's.theme')" = "gruvbox-light/gruvbox-dark" ] || fail "missing theme should default to gruvbox automatic light/dark"
  [ "$(json_get "$settings" 'Object.prototype.hasOwnProperty.call(s, "_comment_managed_retry")')" = "false" ] || fail "managed comments should not be written to user settings"
  [ "$(json_get "$settings" 's.packages.length')" = "1" ] || fail "package should be added exactly once"
  [ "$(json_get "$settings" 's.packages[0]')" = "$repo" ] || fail "package path should be repo"
  [ "$(json_get "$settings" 's.extensions')" = '["-playwright-client"]' ] || fail "playwright-client should be disabled by setup"

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
  [ "$(json_get "$settings" 's.retry.provider.timeoutMs')" = "20000" ] || fail "created settings should include managed timeout"
  [ "$(json_get "$settings" 's.piUpdate.enabled')" = "false" ] || fail "created settings should disable piUpdate"
  [ "$(json_get "$settings" 's.theme')" = "gruvbox-light/gruvbox-dark" ] || fail "created settings should include gruvbox automatic light/dark theme"
  [ "$(json_get "$settings" 's.packages[0]')" = "$repo" ] || fail "created settings should include package"

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

test_disables_browser_extension_without_clobbering_other_extensions() {
  local tmp settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
  cat > "$settings" <<'JSON'
{
  "extensions": ["my-extension", "playwright-client", "extensions/playwright-client", "-playwright-client"]
}
JSON

  apply_settings "$settings" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.extensions')" = '["my-extension","-playwright-client"]' ] || fail "setup should preserve other extensions and disable browser once"

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
  [ "$(json_get "$settings" 's.packages[0]')" = "$repo" ] || fail "worktree setup should register primary checkout"

  git -C "$repo" worktree remove -f "$worktree" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}

test_migrates_only_default_npm_command_to_nub() {
  local tmp settings custom_settings repo
  tmp="$(with_temp_dir)"
  settings="$tmp/settings.json"
  custom_settings="$tmp/custom-settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"
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

test_applies_managed_settings_and_package_once
test_preserves_unmanaged_retry_settings
test_preserves_enabled_pi_update
test_applies_to_missing_settings_file
test_preserves_existing_theme
test_disables_browser_extension_without_clobbering_other_extensions
test_registers_primary_checkout_when_run_from_worktree
test_migrates_only_default_npm_command_to_nub

echo "managed settings tests passed"
