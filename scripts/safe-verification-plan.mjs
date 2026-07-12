import { spawnSync } from "node:child_process";

export const SafeVerificationPhaseId = {
  Format: "format-check",
  Typecheck: "typecheck",
  TypeAwareLint: "type-aware-lint",
  UnitTests: "unit-tests",
  Build: "build",
  QualityAnalysis: "quality-analysis",
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
  {
    id: SafeVerificationPhaseId.QualityAnalysis,
    label: "quality analysis",
    command: "nub",
    args: ["run", "check:quality"],
  },
];

export function formatSafePhase(phase) {
  return phase.skip
    ? `${phase.id}: ${phase.label} — skipped (${phase.skip})`
    : `${phase.id}: ${phase.label} — ${[phase.command, ...phase.args].join(" ")}`;
}

export function runSafeVerificationPlan(phases = SAFE_VERIFICATION_PHASES, run = spawnSync) {
  for (const phase of phases) {
    if (phase.skip) {
      console.log(`\n==> ${phase.label} (skipped: ${phase.skip})`);
      continue;
    }
    console.log(`\n==> ${phase.label}`);
    const result = run(phase.command, phase.args, { stdio: "inherit" });
    if (result.error) {
      console.error(`verify:safe: ${phase.label} failed to start: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
