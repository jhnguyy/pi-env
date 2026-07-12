import { STANDARD_VERIFICATION_PHASES } from "./verification-phases.mjs";
import { listPlan, runPlan } from "./verification-runner.mjs";

export const VERIFICATION_PHASES = STANDARD_VERIFICATION_PHASES;

export function listVerificationPlan(phases = VERIFICATION_PHASES) {
  return listPlan(phases);
}

export function runVerificationPlan(phases = VERIFICATION_PHASES, run) {
  return runPlan(phases, { run, name: "verify" });
}
