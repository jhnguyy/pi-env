#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const phases = [
  ["setup tests", "nub", ["run", "test:setup"]],
  ["typecheck", "nub", ["run", "typecheck"]],
  ["extension build", "nub", ["run", "build"]],
  ["install readiness", "scripts/node-run.sh", ["scripts/verify-install.mjs"]],
  ["unit tests", "nub", ["run", "test:unit"]],
];

for (const [label, command, args] of phases) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`verify: ${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
