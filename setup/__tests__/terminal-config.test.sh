#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
cd "$ROOT"

tmp="$(with_temp_dir)"
mkdir -p "$tmp/home"
"$(node_bin)" --input-type=module - "$ROOT" "$tmp/home" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Effect } from 'effect';
const [root, home] = process.argv.slice(2);
const { configureTerminalToolsEffect } = await import(pathToFileURL(`${root}/setup/terminal-config.mjs`));
const ctx = { home, sourceRoot: '/checkout with spaces/"quote"/$HOME/back\\slash\nline',
  ghosttyConfigDir: `${home}/ghostty`, xdgConfigHome: home };
const policy = { terminal: { enabled: true, tmux: { configure: true }, ghostty: { configure: false } } };
const configure = () => Effect.runPromise(configureTerminalToolsEffect(ctx, policy));
const file = `${home}/.tmux.conf`;
const expected = 'source-file "/checkout with spaces/\\"quote\\"/\\$HOME/back\\\\\\\\slash\\nline/setup/templates/tmux.conf"\n';
await configure();
assert.equal(fs.readFileSync(file, 'utf8'), expected);
await configure();
assert.equal(fs.readFileSync(file, 'utf8'), expected);
fs.writeFileSync(file, 'set -g mouse on\n');
await configure();
assert.equal(fs.readFileSync(file, 'utf8'), `set -g mouse on\n\n${expected}`);
await configure();
assert.equal(fs.readFileSync(file, 'utf8'), `set -g mouse on\n\n${expected}`);
JS

echo "terminal config tests passed"
