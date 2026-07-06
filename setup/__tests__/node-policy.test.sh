#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=setup/__tests__/helpers.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/helpers.sh"
cd "$ROOT"

"$(node_bin)" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertNodePolicy,
  esbuildNodeTarget,
  nodePolicyIssues,
  nodeVersionSatisfies,
  readNodePin,
  readNodeRuntimePin,
} from './scripts/node-policy.mjs';

assert.equal(readNodePin('.node-version'), '24.16.0');
assert.equal(readNodePin('.nvmrc'), '24.16.0');
assert.equal(readNodeRuntimePin(), '24.16.0');
assert.equal(nodeVersionSatisfies('24.16.0'), true);
assert.equal(nodeVersionSatisfies('24.0.0'), false);
assert.equal(nodeVersionSatisfies('23.99.99'), false);
assert.equal(esbuildNodeTarget(), 'node24.0');
assert.deepEqual(nodePolicyIssues(), []);
assert.doesNotThrow(() => assertNodePolicy());

const makeRepo = (pkg, nodeVersion = '24.16.0', nvmrc = nodeVersion) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-env-node-policy-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, '.node-version'), `${nodeVersion}\n`);
  writeFileSync(join(dir, '.nvmrc'), `${nvmrc}\n`);
  return dir;
};

const mismatchedPins = makeRepo({ engines: { node: '>=24.0.0' } }, '24.16.0', '23.0.0');
try {
  assert.match(nodePolicyIssues(mismatchedPins).join('\n'), /\.nvmrc/);
  assert.throws(() => assertNodePolicy(mismatchedPins), /Node policy mismatch/);
} finally {
  rmSync(mismatchedPins, { recursive: true, force: true });
}

const mismatchedRuntime = makeRepo({
  engines: { node: '>=24.0.0' },
  devEngines: { runtime: { name: 'node', version: '24.17.0', onFail: 'error' } },
}, '24.16.0');
try {
  assert.match(nodePolicyIssues(mismatchedRuntime).join('\n'), /devEngines\.runtime\.version/);
} finally {
  rmSync(mismatchedRuntime, { recursive: true, force: true });
}

const mismatchedMajor = makeRepo({ engines: { node: '>=23.0.0' } }, '24.16.0');
try {
  assert.match(nodePolicyIssues(mismatchedMajor).join('\n'), /same major/);
} finally {
  rmSync(mismatchedMajor, { recursive: true, force: true });
}

const unsupportedRange = makeRepo({ engines: { node: '^24.0.0' } }, '24.16.0');
try {
  assert.match(nodePolicyIssues(unsupportedRange).join('\n'), /Unsupported package\.json engines\.node range/);
} finally {
  rmSync(unsupportedRange, { recursive: true, force: true });
}
JS

echo "node policy tests passed"
