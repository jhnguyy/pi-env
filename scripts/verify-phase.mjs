#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { STANDARD_VERIFICATION_PHASES, verificationPhaseById } from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

export function runVerificationPhase(id, options = {}) {
  const phases = options.phases ?? STANDARD_VERIFICATION_PHASES;
  const phase = verificationPhaseById(id, phases);
  if (phase === undefined) {
    const expected = phases.map((candidate) => candidate.id).join(", ");
    (options.logError ?? console.error)(
      `verify:phase: unknown phase ${JSON.stringify(id)}; expected one of: ${expected}`,
    );
    return 2;
  }
  return runPlan([phase], { ...options, name: "verify:phase" });
}

export function main(args = process.argv.slice(2)) {
  if (args.includes("--list")) {
    console.log(listPlan(STANDARD_VERIFICATION_PHASES).join("\n"));
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
