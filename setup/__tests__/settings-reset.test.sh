#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
source "$ROOT/setup/options.sh"
source "$ROOT/setup/context.sh"

EVIDENCE=$(mktemp -d "${PI_ENV_SETUP_EVIDENCE_DIR:-${TMPDIR:-/tmp}}/pi-env-settings-XXXXXX")
export HOME="$EVIDENCE/home"
# Test state must never inherit an agent directory from the caller.
export PI_AGENT_DIR="$HOME/.pi/agent" PI_CODING_AGENT_DIR="$HOME/.pi/agent"
mkdir -p "$HOME"
setup_init_context "$ROOT/setup"
export REPO SETUP_DIR SETTINGS_FILE AGENTS_DIR TEST_UTILS_DIR APPEND_SRC APPEND_DST APPEND_MARKER PI_AGENT_DIR TMUX_CONF TMUX_SOURCE_LINE GHOSTTY_CONFIG_DIR POST_MERGE_HOOK_SRC PRE_COMMIT_HOOK_SRC
export PI_ENV_SETUP_MODE=portable PI_ENV_SKIP_TERMINAL=1 PI_ENV_SKIP_REPO_HOOKS=1 PI_ENV_SKIP_HOME_MANAGER=1
NODE=$(node_bin)
configure() {
  setup_parse_args "$@" --no-terminal --no-repo-hooks --no-home-manager
  "$NODE" "$ROOT/setup/configure.mjs" pi "$NODE" >>"$EVIDENCE/workflow.log" 2>&1
}
mkdir -p "$PI_AGENT_DIR/sessions" "$PI_AGENT_DIR/files"
printf '%s\n' '{"openai":{"type":"oauth"},"openai-codex":{"type":"oauth"}}' > "$PI_AGENT_DIR/auth.json"
for name in models.json mcp.json keybindings.json sessions/keep files/keep; do
  printf 'sentinel\n' > "$PI_AGENT_DIR/$name"
done
configure
cp "$SETTINGS_FILE" "$EVIDENCE/initial.json"
cat > "$SETTINGS_FILE" <<'JSON'
{
  "defaultProvider": "anthropic", "defaultModel": "personal", "defaultThinkingLevel": "high",
  "defaultTools": [], "npmCommand": ["npm"], "theme": "gruvbox-dark",
  "images": {"blockImages": false}, "permissionLevel": "personal",
  "transport": "personal", "retry": {"enabled": false}, "piUpdate": {"enabled": true},
  "extensions": ["personal"], "custom": {"keep": true}, "packages": ["npm:personal-package"]
}
JSON
cp "$SETTINGS_FILE" "$EVIDENCE/personal.json"
configure
cp "$SETTINGS_FILE" "$EVIDENCE/normal.json"
configure --reset
cp "$SETTINGS_FILE" "$EVIDENCE/reset.json"
configure
cp "$SETTINGS_FILE" "$EVIDENCE/rerun.json"

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

cp "$SETTINGS_FILE" "$EVIDENCE/before-failure.json"
if "$NODE" "$ROOT/setup/apply-managed-settings.mjs" "$SETTINGS_FILE" "$EVIDENCE/missing-repo" --reset >>"$EVIDENCE/workflow.log" 2>&1; then
  fail "🤖: reset registration failure should fail"
fi
cmp "$SETTINGS_FILE" "$EVIDENCE/before-failure.json" || fail "🤖: failed reset did not roll back"
for metadata in codex neither; do
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
cat > "$EVIDENCE/result.json" <<'JSON'
{"inputs":"personal.json and metadata-only auth fixtures","expected":"normal preserves choices; explicit reset backs up and replaces baseline and packages; registration failure rolls back; unrelated files remain","actual":"all workflow assertions passed","verdict":"pass","reproduce":"PI_ENV_REPO=$PWD bash setup/__tests__/settings-reset.test.sh","inspect":"Compare personal.json, normal.json, reset.json, rerun.json, codex.json, neither.json and home/.pi/agent/settings.json.backup-*; workflow.log retains failure output."}
JSON
printf '🤖: Settings/reset evidence: %s\n' "$EVIDENCE"
