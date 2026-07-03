#!/usr/bin/env node
import { readNodeRequirement, nodeVersionSatisfies } from './node-policy.mjs';

const repo = process.argv[2] || process.cwd();
const requirement = readNodeRequirement(repo);

if (!requirement) {
  process.exit(0);
}

if (!nodeVersionSatisfies(process.versions.node, repo)) {
  console.error(`Node.js ${requirement} is required; found ${process.version}`);
  process.exit(1);
}
