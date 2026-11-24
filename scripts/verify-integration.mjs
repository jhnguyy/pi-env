#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runPlan } from "./verification-runner.mjs";

const {
  values: { prebuilt },
} = parseArgs({
  options: { prebuilt: { type: "boolean", default: false } },
});

// Source qualification builds first; image qualification checks the baked output
// instead. Both paths exercise the same tests without replacing an image's bundles.
const scripts = [
  "format:check",
  "check:patterns",
  "check:dependencies",
  "licenses:check",
  "typecheck",
  "lint:type",
  prebuilt ? "verify:install" : "build",
  "test:setup",
  "test:unit",
  "test:integration",
  ...(!prebuilt ? ["verify:install"] : []),
  "test:workflows",
];

process.exitCode = runPlan(
  scripts.map((name) => ({ label: name, command: "nub", args: ["run", name] })),
  { reportDirectory: process.env.PI_ENV_REPORT_DIR },
);
