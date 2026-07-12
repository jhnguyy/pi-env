import { SAFE_VERIFICATION_PHASES } from "./verification-phases.mjs";
import { formatPhase, runPlan } from "./verification-runner.mjs";

export { SAFE_VERIFICATION_PHASES };

export function formatSafePhase(phase) {
  return formatPhase(phase);
}

export function runSafeVerificationPlan(phases = SAFE_VERIFICATION_PHASES, run) {
  return runPlan(phases, { run, name: "verify:safe" });
}
