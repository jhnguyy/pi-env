import { spawnSync } from "node:child_process";

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

export function formatPhaseCommand(phase) {
  return [phase.command, ...phase.args].join(" ");
}

export function listVerificationPlan(phases = VERIFICATION_PHASES) {
  return phases.map((phase) => `${phase.id}: ${phase.label} — ${formatPhaseCommand(phase)}`);
}

export function runVerificationPlan(phases = VERIFICATION_PHASES) {
  for (const phase of phases) {
    console.log(`\n==> ${phase.label}`);
    const result = spawnSync(phase.command, phase.args, { stdio: "inherit" });
    if (result.error) {
      console.error(`verify: ${phase.label} failed to start: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
