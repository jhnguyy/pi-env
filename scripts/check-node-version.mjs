#!/usr/bin/env node
import { assertNodePolicy, readNodeRequirement, nodeVersionSatisfies } from './node-policy.mjs';

const repo = process.argv[2] || process.cwd();

try {
  assertNodePolicy(repo);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const requirement = readNodeRequirement(repo);

if (!requirement) {
  process.exit(0);
}

if (!nodeVersionSatisfies(process.versions.node, repo)) {
  console.error(`Node.js ${requirement} is required; found ${process.version}`);
  process.exit(1);
}
