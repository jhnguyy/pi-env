#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { EXPLICIT_VERIFICATION_PHASES, verificationPhaseById } from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

function runVerificationPhase(id) {
  const phase = verificationPhaseById(id, EXPLICIT_VERIFICATION_PHASES);
  if (phase === undefined) {
    const expected = EXPLICIT_VERIFICATION_PHASES.map((candidate) => candidate.id).join(", ");
    console.error(
      `verify:phase: unknown phase ${JSON.stringify(id)}; expected one of: ${expected}`,
    );
    return 2;
  }
  return runPlan([phase], { name: "verify:phase" });
}

function main(args = process.argv.slice(2)) {
  if (args.includes("--list")) {
    console.log(listPlan(EXPLICIT_VERIFICATION_PHASES).join("\n"));
    return 0;
  }
  if (args.length !== 1) {
    console.error("usage: scripts/verify-phase.mjs <phase-id> | --list");
    return 2;
  }
  return runVerificationPhase(args[0]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
