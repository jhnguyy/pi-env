#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
cd "$ROOT"

"$(node_bin)" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'pi-env-node-policy-'));
const check = range => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: range } }));
  return spawnSync(process.execPath, ['scripts/check-node-version.mjs', dir], { encoding: 'utf8' });
};
const actual = process.versions.node;
const [major, minor, patch] = actual.split('.').map(Number);
assert.equal(check(`>=${major}.${minor}.${patch}`).status, 0);
assert.equal(check(`>=${major - 1}.0.0`).status, 0);
const tooOld = check(`>=${major + 1}.0.0`);
assert.equal(tooOld.status, 1);
assert.match(tooOld.stderr, /is required; found/);
const unsupported = check(`^${major}.0.0`);
assert.equal(unsupported.status, 1);
assert.match(unsupported.stderr, /Unsupported package.json engines.node range/);
writeFileSync(join(dir, 'result.json'), JSON.stringify({actual, expected: 'minimum runtime passes; newer compatible runtime passes; lower runtime and unsupported policy fail', verdict: 'pass', reproduce: 'bash setup/__tests__/node-policy.test.sh'}, null, 2));
console.log(`Node policy evidence: ${dir}`);
JS
