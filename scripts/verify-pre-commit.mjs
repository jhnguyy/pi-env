#!/usr/bin/env node
import { PRE_COMMIT_VERIFICATION_PHASES } from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

if (process.argv.includes("--list")) {
  console.log(listPlan(PRE_COMMIT_VERIFICATION_PHASES).join("\n"));
  process.exit(0);
}

process.exit(runPlan(PRE_COMMIT_VERIFICATION_PHASES, { name: "verify:pre-commit" }));
