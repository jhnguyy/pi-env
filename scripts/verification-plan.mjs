import { listPlan, runPlan } from "./verification-runner.mjs";

export const VerificationPhaseId = {
  SetupTests: "setup-tests",
  Typecheck: "typecheck",
  Build: "build",
  InstallReadiness: "install-readiness",
  UnitTests: "unit-tests",
};

export const VERIFICATION_PHASES = [
  {
    id: VerificationPhaseId.SetupTests,
    label: "setup tests",
    command: "nub",
    args: ["run", "test:setup"],
  },
  {
    id: VerificationPhaseId.Typecheck,
    label: "typecheck",
    command: "nub",
    args: ["run", "typecheck"],
  },
  {
    id: VerificationPhaseId.Build,
    label: "extension build",
    command: "nub",
    args: ["run", "build"],
  },
  {
    id: VerificationPhaseId.InstallReadiness,
    label: "install readiness",
    command: "scripts/node-run.sh",
    args: ["scripts/verify-install.mjs"],
  },
  {
    id: VerificationPhaseId.UnitTests,
    label: "unit tests",
    command: "nub",
    args: ["run", "test:unit"],
  },
];

export function listVerificationPlan(phases = VERIFICATION_PHASES) {
  return listPlan(phases);
}

export function runVerificationPlan(phases = VERIFICATION_PHASES, run) {
  return runPlan(phases, { run, name: "verify" });
}
