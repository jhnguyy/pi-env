#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/setup/apply-managed-settings.mjs"
MANAGED="$ROOT/setup/managed-settings.json"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

json_get() {
  local file="$1" expr="$2"
  node -e "const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')); const value = $expr; console.log(Array.isArray(value) ? JSON.stringify(value) : value);" "$file"
}

test_applies_managed_settings_and_package_once() {
  local tmp settings repo first second
  tmp="$(mktemp -d)"
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

  first=$(node "$SCRIPT" "$settings" "$MANAGED" "$repo")
  second=$(node "$SCRIPT" "$settings" "$MANAGED" "$repo")

  [ "$first" = "updated" ] || fail "first run should update settings, got $first"
  [ "$second" = "unchanged" ] || fail "second run should be unchanged, got $second"
  [ "$(json_get "$settings" 's.defaultProvider')" = "anthropic" ] || fail "defaultProvider should be preserved"
  [ "$(json_get "$settings" 's.retry.enabled')" = "true" ] || fail "retry.enabled should be true"
  [ "$(json_get "$settings" 's.retry.provider.timeoutMs')" = "20000" ] || fail "provider timeout should be 20000"
  [ "$(json_get "$settings" 's.retry.provider.maxRetries')" = "1" ] || fail "provider retries should be 1"
  [ "$(json_get "$settings" 's.piUpdate.enabled')" = "false" ] || fail "piUpdate should default to disabled"
  [ "$(json_get "$settings" 'Object.prototype.hasOwnProperty.call(s, "_comment_managed_retry")')" = "false" ] || fail "managed comments should not be written to user settings"
  [ "$(json_get "$settings" 's.packages.length')" = "1" ] || fail "package should be added exactly once"
  [ "$(json_get "$settings" 's.packages[0]')" = "$repo" ] || fail "package path should be repo"

  rm -rf "$tmp"
}

test_preserves_unmanaged_retry_settings() {
  local tmp settings repo
  tmp="$(mktemp -d)"
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

  node "$SCRIPT" "$settings" "$MANAGED" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.retry.customLocalSetting')" = "keep-me" ] || fail "unmanaged retry key should be preserved"
  [ "$(json_get "$settings" 's.retry.provider.customProviderSetting')" = "keep-me-too" ] || fail "unmanaged provider key should be preserved"

  rm -rf "$tmp"
}

test_preserves_enabled_pi_update() {
  local tmp settings repo
  tmp="$(mktemp -d)"
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

  node "$SCRIPT" "$settings" "$MANAGED" "$repo" >/dev/null

  [ "$(json_get "$settings" 's.piUpdate.enabled')" = "true" ] || fail "piUpdate.enabled=true should be preserved"

  rm -rf "$tmp"
}

test_applies_to_missing_settings_file() {
  local tmp settings repo result
  tmp="$(mktemp -d)"
  settings="$tmp/nested/settings.json"
  repo="$tmp/repo"
  mkdir -p "$repo"

  result=$(node "$SCRIPT" "$settings" "$MANAGED" "$repo")

  [ "$result" = "created" ] || fail "missing settings should be created, got $result"
  [ "$(json_get "$settings" 's.retry.provider.timeoutMs')" = "20000" ] || fail "created settings should include managed timeout"
  [ "$(json_get "$settings" 's.piUpdate.enabled')" = "false" ] || fail "created settings should disable piUpdate"
  [ "$(json_get "$settings" 's.packages[0]')" = "$repo" ] || fail "created settings should include package"

  rm -rf "$tmp"
}

test_applies_managed_settings_and_package_once
test_preserves_unmanaged_retry_settings
test_preserves_enabled_pi_update
test_applies_to_missing_settings_file

echo "managed settings tests passed"
