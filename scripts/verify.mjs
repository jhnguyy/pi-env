#!/usr/bin/env node
import { listVerificationPlan, runVerificationPlan } from "./verification-plan.mjs";

if (process.argv.includes("--list")) {
  console.log(listVerificationPlan().join("\n"));
  process.exit(0);
}

process.exit(runVerificationPlan());
