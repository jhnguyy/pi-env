import { formatPhase, runPlan } from "./verification-runner.mjs";

export const SafeVerificationPhaseId = {
  Format: "format-check",
  Typecheck: "typecheck",
  TypeAwareLint: "type-aware-lint",
  UnitTests: "unit-tests",
  Build: "build",
};

export const SAFE_VERIFICATION_PHASES = [
  {
    id: SafeVerificationPhaseId.Format,
    label: "format check",
    command: "nub",
    args: ["run", "format:check"],
  },
  {
    id: SafeVerificationPhaseId.Typecheck,
    label: "typecheck",
    command: "nub",
    args: ["run", "typecheck"],
  },
  {
    id: SafeVerificationPhaseId.TypeAwareLint,
    label: "type-aware lint",
    command: "nub",
    args: ["run", "lint:type"],
  },
  {
    id: SafeVerificationPhaseId.UnitTests,
    label: "unit tests (one worker)",
    command: "nub",
    args: ["run", "test:safe"],
  },
  {
    id: SafeVerificationPhaseId.Build,
    label: "extension build",
    command: "nub",
    args: ["run", "build"],
  },
];

export function formatSafePhase(phase) {
  return formatPhase(phase);
}

export function runSafeVerificationPlan(phases = SAFE_VERIFICATION_PHASES, run) {
  return runPlan(phases, { run, name: "verify:safe" });
}
