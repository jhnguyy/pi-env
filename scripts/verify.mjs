#!/usr/bin/env node
import { STANDARD_VERIFICATION_PHASES } from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

if (process.argv.includes("--list")) {
  console.log(listPlan(STANDARD_VERIFICATION_PHASES).join("\n"));
  process.exit(0);
}

process.exit(runPlan(STANDARD_VERIFICATION_PHASES));
