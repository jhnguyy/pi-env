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
mkdir -p "$HOME/.pi/agent" "$PI_CODING_AGENT_DIR"
printf '%s\n' "$UNSELECTED" > "$HOME/.pi/agent/settings.json"

setup_init_context "$ROOT/setup"
export REPO SETTINGS_FILE="$PI_AGENT_DIR/settings.json" PI_ENV_SETUP_MODE=portable
configure() {
  setup_parse_args "$@" --no-terminal --no-repo-hooks --no-home-manager
  quiet "$NODE" "$ROOT/setup/configure.mjs" pi "$NODE"
}

configure
INITIAL=$(cat "$SETTINGS_FILE")
PERSONAL='{"defaultModel": "personal", "theme": "personal-theme", "packages": ["npm:personal-package"],
  "httpIdleTimeoutMs": 0, "retry": {"enabled": false, "maxAgentDelayMs": 5000}}'
printf '%s\n' "$PERSONAL" > "$SETTINGS_FILE"
configure
NORMAL=$(cat "$SETTINGS_FILE")
configure --reset
RESET=$(cat "$SETTINGS_FILE")
configure
RERUN=$(cat "$SETTINGS_FILE")

PRIMARY_REPO=$(git -C "$ROOT" worktree list --porcelain | awk '/^worktree / { print substr($0, 10); exit }')
INITIAL="$INITIAL" PERSONAL="$PERSONAL" NORMAL="$NORMAL" RESET="$RESET" RERUN="$RERUN" \
  PRIMARY_REPO="$PRIMARY_REPO" "$NODE" --input-type=module - "$ROOT/setup/managed-settings-core.mjs" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const { applyManagedSettings, initialSettings } = await import(process.argv[2]);
const env = process.env;
const [personal, normal, reset] = [env.PERSONAL, env.NORMAL, env.RESET].map((text) => JSON.parse(text));
const sources = (settings) => settings.packages.map((source) =>
  source.startsWith('npm:') ? source : path.resolve(path.dirname(env.SETTINGS_FILE), source)).sort();
const withoutPackages = ({ packages, ...rest }) => rest;

// Normal setup keeps personal choices except managed keys, and adds pi-env beside personal packages.
assert.deepEqual(withoutPackages(normal), withoutPackages(applyManagedSettings(personal)));
assert.deepEqual(sources(normal), [...personal.packages, env.PRIMARY_REPO].sort());
// Reset and fresh setup produce the baseline with only pi-env; reruns keep it.
assert.deepEqual(withoutPackages(reset), applyManagedSettings(initialSettings()));
assert.deepEqual(sources(reset), [env.PRIMARY_REPO]);
assert.deepEqual(JSON.parse(env.INITIAL), reset);
assert.deepEqual(JSON.parse(env.RERUN), reset);
// Reset backs up the exact file it replaced.
const backups = fs.readdirSync(env.PI_AGENT_DIR).filter((name) => name.startsWith('settings.json.backup-'));
assert.deepEqual(backups.map((name) => fs.readFileSync(path.join(env.PI_AGENT_DIR, name), 'utf8')), [`${env.NORMAL}\n`]);
JS

for args in "" --reset; do
  printf '%s\n' "$PERSONAL" > "$SETTINGS_FILE"
  if "$NODE" "$ROOT/setup/apply-managed-settings.mjs" "$SETTINGS_FILE" "$TMP/missing-repo" $args 2>/dev/null; then
    fail "registration failure should fail (${args:-normal})"
  fi
  same_bytes "$SETTINGS_FILE" "$PERSONAL" || fail "registration failure did not restore exact settings (${args:-normal})"
done

if PI_AGENT_DIR="$HOME/.pi/agent" PI_CODING_AGENT_DIR="$TMP/selected-agent" "$ROOT/setup.sh" --reset --help >/dev/null 2>&1; then
  fail 'conflicting agent directories must fail before provisioning or writes'
fi
same_bytes "$HOME/.pi/agent/settings.json" "$UNSELECTED" || fail 'setup changed the unselected settings'
echo "settings reset tests passed"
