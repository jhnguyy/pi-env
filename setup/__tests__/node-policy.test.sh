#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
cd "$ROOT"

"$(node_bin)" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'pi-env-node-policy-'));
console.log(`Node policy evidence: ${dir}`);
const version = process.versions.node;
const [major] = version.split('.').map(Number);
const cases = [
  {range: `>=${version}`, expectedStatus: 0},
  {range: `>=${major - 1}.0.0`, expectedStatus: 0},
  {range: `>=${major + 1}.0.0`, expectedStatus: 1},
  {range: `^${major}.0.0`, expectedStatus: 1},
];
const results = [];
let verdict = 'fail';
try {
  for (const [index, input] of cases.entries()) {
    const repo = join(dir, `case-${index + 1}`);
    mkdirSync(repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({engines: {node: input.range}}));
    const actual = spawnSync(process.execPath, ['scripts/check-node-version.mjs', repo], {encoding: 'utf8'});
    results.push({...input, status: actual.status, stdout: actual.stdout, stderr: actual.stderr, error: actual.error?.message});
    assert.equal(actual.status, input.expectedStatus, input.range);
  }
  verdict = 'pass';
} finally {
  writeFileSync(join(dir, 'result.json'), JSON.stringify({
    inputs: {version, cases}, expected: 'minimum and compatible newer runtimes pass; too-old runtime and unsupported policy fail',
    actual: results, verdict, reproduce: 'bash setup/__tests__/node-policy.test.sh',
    inspect: 'result.json and each case-*/package.json',
  }, null, 2) + '\n');
}
JS
