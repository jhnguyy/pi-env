#!/usr/bin/env bash
# Exercise settings ownership without provisioning dependencies or running hooks.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
source "$ROOT/setup/options.sh"
source "$ROOT/setup/context.sh"
NODE=$(node_bin)
TMP=$(with_temp_dir)

# Exact bytes, including the trailing newline that $(...) would strip.
same_bytes() {
  cmp -s "$1" <(printf '%s\n' "$2")
}

export HOME="$TMP/home"
export AGENTS_DIR="$HOME/.agents" XDG_CONFIG_HOME="$HOME/.config" GHOSTTY_CONFIG_DIR="$HOME/.config/ghostty"
unset PI_AGENT_DIR
export PI_CODING_AGENT_DIR="$TMP/selected-agent"
UNSELECTED='{"defaultThinkingLevel":"high"}'
mkdir -p "$HOME/.pi/agent"
printf '%s\n' "$UNSELECTED" > "$HOME/.pi/agent/settings.json"

setup_init_context "$ROOT/setup"
assert_eq "$PI_AGENT_DIR" "$PI_CODING_AGENT_DIR" 'setup uses the native agent directory'
export REPO SETTINGS_FILE="$PI_AGENT_DIR/settings.json"
export PI_ENV_SETUP_MODE=portable
configure() {
  setup_parse_args "$@" --no-terminal --no-repo-hooks --no-home-manager
  quiet "$NODE" "$ROOT/setup/configure.mjs" pi "$NODE"
}
mkdir -p "$PI_AGENT_DIR"
printf '%s\n' '{"openai":{"type":"oauth"},"openai-codex":{"type":"oauth"}}' > "$PI_AGENT_DIR/auth.json"

configure
INITIAL=$(cat "$SETTINGS_FILE")
PERSONAL='{
  "defaultProvider": "anthropic", "defaultModel": "personal", "defaultThinkingLevel": "high",
  "defaultTools": [], "npmCommand": ["personal-command"], "theme": "personal-theme",
  "extensions": ["personal"], "custom": {"keep": true}, "packages": ["npm:personal-package"],
  "httpIdleTimeoutMs": 0,
  "retry": {"enabled": false, "maxAgentDelayMs": 5000, "provider": {"maxRetries": 4, "keep": true}}
}'
printf '%s\n' "$PERSONAL" > "$SETTINGS_FILE"
configure
NORMAL=$(cat "$SETTINGS_FILE")
configure --reset
RESET=$(cat "$SETTINGS_FILE")
configure
RERUN=$(cat "$SETTINGS_FILE")

PRIMARY_REPO=$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree / { print substr($0, 10); exit }')
INITIAL="$INITIAL" PERSONAL="$PERSONAL" NORMAL="$NORMAL" RESET="$RESET" RERUN="$RERUN" \
  PRIMARY_REPO="$PRIMARY_REPO" "$NODE" --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const env = process.env;
const managed = {
  httpIdleTimeoutMs: 120000,
  retry: {enabled: true, maxRetries: 3, baseDelayMs: 7500,
    provider: {timeoutMs: 30000, maxRetries: 0, maxRetryDelayMs: 60000}},
};
const personal = JSON.parse(env.PERSONAL);
const normal = JSON.parse(env.NORMAL);
// Managed keys win on every run; unmanaged siblings in managed objects survive.
assert.deepEqual({...normal, packages: personal.packages}, {
  ...personal, httpIdleTimeoutMs: managed.httpIdleTimeoutMs,
  retry: {...managed.retry, maxAgentDelayMs: 5000, provider: {...managed.retry.provider, keep: true}},
});
const registeredSources = settings => settings.packages.map(source =>
  source.startsWith('npm:') ? source : path.resolve(path.dirname(env.SETTINGS_FILE), source)).sort();
assert.deepEqual(registeredSources(normal), [...personal.packages, env.PRIMARY_REPO].sort());
const reset = JSON.parse(env.RESET);
const {packages, theme, ...baseline} = reset;
assert.deepEqual(baseline, {
  defaultProvider: 'openai', defaultModel: 'gpt-6.1-sol', defaultThinkingLevel: 'medium',
  defaultTools: ['+codemode', '+tool_search'], npmCommand: ['nub'],
  ...managed,
});
assert.deepEqual(registeredSources(reset), [env.PRIMARY_REPO]);
assert.deepEqual(JSON.parse(env.INITIAL), reset);
assert.deepEqual(JSON.parse(env.RERUN), reset);
const backups = fs.readdirSync(env.PI_AGENT_DIR).filter(name => name.startsWith('settings.json.backup-'));
assert.equal(backups.length, 1);
assert.equal(fs.readFileSync(path.join(env.PI_AGENT_DIR, backups[0]), 'utf8'), `${env.NORMAL}\n`);
JS

for args in "" --reset; do
  printf '%s\n' "$PERSONAL" > "$SETTINGS_FILE"
  if "$NODE" "$ROOT/setup/apply-managed-settings.mjs" "$SETTINGS_FILE" "$TMP/missing-repo" $args 2>/dev/null; then
    fail "registration failure should fail (${args:-normal})"
  fi
  same_bytes "$SETTINGS_FILE" "$PERSONAL" || fail "registration failure did not restore exact settings (${args:-normal})"
done

for case in 'openai-codex:{"openai-codex":{"type":"oauth"}}' 'openai:{}'; do
  printf '%s\n' "${case#*:}" > "$PI_AGENT_DIR/auth.json"
  configure --reset
  assert_eq "$("$NODE" -p 'require(process.argv[1]).defaultProvider' "$SETTINGS_FILE")" "${case%%:*}" \
    "provider from auth metadata ${case#*:}"
done

if PI_AGENT_DIR="$HOME/.pi/agent" PI_CODING_AGENT_DIR="$TMP/selected-agent" "$ROOT/setup.sh" --reset --help >/dev/null 2>&1; then
  fail 'conflicting agent directories must fail before provisioning or writes'
fi
same_bytes "$HOME/.pi/agent/settings.json" "$UNSELECTED" || fail 'setup changed the unselected settings'
echo "settings reset tests passed"
