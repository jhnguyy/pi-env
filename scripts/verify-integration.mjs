#!/usr/bin/env node
import { runPlan } from "./verification-runner.mjs";

// This is the full qualification order, shared by local and container verification.
const scripts = [
  "format:check",
  "check:patterns",
  "check:dependencies",
  "licenses:check",
  "typecheck",
  "lint:type",
  "build",
  "test:setup",
  "test:unit",
  "test:integration",
  "verify:install",
  "test:workflows",
];

process.exitCode = runPlan(
  scripts.map((name) => ({ label: name, command: "nub", args: ["run", name] })),
  { reportDirectory: process.env.PI_ENV_REPORT_DIR },
);
