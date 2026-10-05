#!/usr/bin/env bash
# Exercise settings ownership without provisioning dependencies or running hooks.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
source "$ROOT/setup/options.sh"
source "$ROOT/setup/context.sh"
NODE=$(node_bin)
EVIDENCE=$(mktemp -d "${PI_ENV_SETUP_EVIDENCE_DIR:-${TMPDIR:-/tmp}}/pi-env-settings-XXXXXX")
printf 'Settings workflow evidence: %s\n' "$EVIDENCE"
exec 3>&1
exec >>"$EVIDENCE/workflow.log" 2>&1
phase=initialization
finish() {
  local status=$?
  EVIDENCE="$EVIDENCE" STATUS="$status" PHASE="$phase" "$NODE" --input-type=module <<'JS'
import fs from 'node:fs';
const {EVIDENCE: dir, STATUS: status, PHASE: phase} = process.env;
fs.writeFileSync(`${dir}/result.json`, JSON.stringify({
  inputs: 'personal.json, legacy JSON settings, metadata-only auth fixtures',
  expected: 'normal preferences survive; explicit reset replaces baseline/packages and keeps state; registration failures restore exact settings',
  actual: {phase, exitStatus: Number(status)}, verdict: status === '0' ? 'pass' : 'fail',
  reproduce: 'bash setup/__tests__/settings-reset.test.sh',
  inspect: 'workflow.log, before/after JSON, and home/.pi/agent/settings.json.backup-*',
}, null, 2) + '\n');
JS
  printf 'Settings workflow exit: %s (%s)\n' "$status" "$phase" >&3
  exit "$status"
}
trap finish EXIT
export HOME="$EVIDENCE/home"
unset PI_AGENT_DIR
export PI_CODING_AGENT_DIR="$EVIDENCE/selected-agent"
mkdir -p "$HOME/.pi/agent"
printf '%s\n' '{"defaultThinkingLevel":"high"}' > "$HOME/.pi/agent/settings.json"
cp "$HOME/.pi/agent/settings.json" "$EVIDENCE/unselected-settings.json"
phase='native agent-directory selection'
setup_init_context "$ROOT/setup"
assert_eq "$SETTINGS_FILE" "$PI_CODING_AGENT_DIR/settings.json" 'base settings use native agent directory'
export REPO SETUP_DIR SETTINGS_FILE AGENTS_DIR TEST_UTILS_DIR APPEND_SRC APPEND_DST APPEND_MARKER PI_AGENT_DIR TMUX_CONF TMUX_SOURCE_LINE GHOSTTY_CONFIG_DIR POST_MERGE_HOOK_SRC PRE_COMMIT_HOOK_SRC
export PI_ENV_SETUP_MODE=portable PI_ENV_SKIP_TERMINAL=1 PI_ENV_SKIP_REPO_HOOKS=1 PI_ENV_SKIP_HOME_MANAGER=1
configure() {
  setup_parse_args "$@" --no-terminal --no-repo-hooks --no-home-manager
  "$NODE" "$ROOT/setup/configure.mjs" pi "$NODE"
}
mkdir -p "$PI_AGENT_DIR/sessions" "$PI_AGENT_DIR/files"
printf '%s\n' '{"openai":{"type":"oauth"},"openai-codex":{"type":"oauth"}}' > "$PI_AGENT_DIR/auth.json"
for name in models.json mcp.json keybindings.json sessions/keep files/keep; do
  printf 'sentinel\n' > "$PI_AGENT_DIR/$name"
done
phase='fresh settings'
configure
cp "$SETTINGS_FILE" "$EVIDENCE/initial.json"
cat > "$EVIDENCE/personal.json" <<'JSON'
{
  "defaultProvider": "anthropic", "defaultModel": "personal", "defaultThinkingLevel": "high",
  "defaultTools": [], "npmCommand": ["npm"], "theme": "gruvbox-dark",
  "extensions": ["personal"], "custom": {"keep": true}, "packages": ["npm:personal-package"]
}
JSON
# The expected preferences remain plain JSON, independent of the production parser.
"$NODE" -e 'const fs = require("fs"); const text = fs.readFileSync(process.argv[1], "utf8"); fs.writeFileSync(process.argv[2], "// legacy personal settings\n" + text.replace(/\n}\s*$/, ",\n}\n"));' "$EVIDENCE/personal.json" "$SETTINGS_FILE"
cp "$SETTINGS_FILE" "$EVIDENCE/legacy.json"
phase='normal legacy settings registration'
configure
cp "$SETTINGS_FILE" "$EVIDENCE/normal.json"
phase='explicit reset'
configure --reset
cp "$SETTINGS_FILE" "$EVIDENCE/reset.json"
phase='normal rerun'
configure
cp "$SETTINGS_FILE" "$EVIDENCE/rerun.json"
phase='preference and state assertions'
EVIDENCE="$EVIDENCE" "$NODE" --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const dir = process.env.EVIDENCE;
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const personal = read('personal.json');
const normal = read('normal.json');
assert.deepEqual({...normal, packages: personal.packages}, personal);
assert.equal(normal.packages.length, 2);
const reset = read('reset.json');
const {packages, ...baseline} = reset;
assert.deepEqual(baseline, {
  defaultProvider: 'openai', defaultModel: 'gpt-6.1-sol', defaultThinkingLevel: 'medium',
  defaultTools: ['+codemode', '+tool_search'], npmCommand: ['nub'],
});
assert.equal(packages.length, 1);
assert.deepEqual(read('initial.json'), reset);
assert.deepEqual(read('rerun.json'), reset);
const agent = process.env.PI_AGENT_DIR;
const backups = fs.readdirSync(agent).filter(name => name.startsWith('settings.json.backup-'));
assert.equal(backups.length, 1);
assert.equal(fs.readFileSync(path.join(agent, backups[0]), 'utf8'), fs.readFileSync(path.join(dir, 'normal.json'), 'utf8'));
for (const name of ['models.json', 'mcp.json', 'keybindings.json', 'sessions/keep', 'files/keep'])
  assert.equal(fs.readFileSync(path.join(agent, name), 'utf8'), 'sentinel\n');
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, 'auth.json'), 'utf8')), {openai: {type: 'oauth'}, 'openai-codex': {type: 'oauth'}});
JS
cp "$EVIDENCE/legacy.json" "$SETTINGS_FILE"
for mode in normal reset; do
  phase="$mode registration rollback"
  args=()
  if [ "$mode" = reset ]; then args=(--reset); fi
  if "$NODE" "$ROOT/setup/apply-managed-settings.mjs" "$SETTINGS_FILE" "$EVIDENCE/missing-repo" "${args[@]}"; then
    fail 'registration failure should fail'
  fi
  cmp "$SETTINGS_FILE" "$EVIDENCE/legacy.json" || fail 'registration failure did not restore exact legacy settings'
done
for metadata in codex neither; do
  phase="provider metadata: $metadata"
  if [ "$metadata" = codex ]; then
    printf '%s\n' '{"openai-codex":{"type":"oauth"}}' > "$PI_AGENT_DIR/auth.json"
    expected=openai-codex
  else
    printf '{}\n' > "$PI_AGENT_DIR/auth.json"
    expected=openai
  fi
  configure --reset
  "$NODE" -e 'const s = require(process.argv[1]); if (s.defaultProvider !== process.argv[2]) process.exit(1)' "$SETTINGS_FILE" "$expected"
  cp "$SETTINGS_FILE" "$EVIDENCE/$metadata.json"
done
phase='conflicting agent directories'
if PI_AGENT_DIR="$HOME/.pi/agent" PI_CODING_AGENT_DIR="$EVIDENCE/selected-agent" "$ROOT/setup.sh" --reset --help; then
  fail 'conflicting agent directories must fail before provisioning or writes'
fi
cmp "$HOME/.pi/agent/settings.json" "$EVIDENCE/unselected-settings.json" || fail 'setup changed the unselected settings'
phase=complete
