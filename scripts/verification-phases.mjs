export const VerificationClass = Object.freeze({
  Static: "static",
  Contract: "contract",
  SafetyIntegration: "safety-integration",
  Packaging: "packaging",
});

export const VerificationCapability = Object.freeze({
  SourcePolicy: "source-policy",
  SetupPortability: "setup-portability",
  TypeSafety: "type-safety",
  ExtensionIntegrity: "extension-integrity",
  InstallIntegrity: "install-integrity",
  RuntimeBehavior: "runtime-behavior",
});

function phase(id, label, command, args, classification, capability) {
  return Object.freeze({
    id,
    label,
    command,
    args: Object.freeze(args),
    classification,
    capability,
  });
}

export const VerificationPhase = Object.freeze({
  Format: phase(
    "format-check",
    "format check",
    "nub",
    ["run", "format:check"],
    VerificationClass.Static,
    VerificationCapability.SourcePolicy,
  ),
  EffectV4Readiness: phase(
    "effect-v4-readiness",
    "Effect v4 readiness",
    "nub",
    ["run", "check:effect-v4"],
    VerificationClass.Static,
    VerificationCapability.SourcePolicy,
  ),
  PatternCheck: phase(
    "pattern-check",
    "pattern guardrails",
    "nub",
    ["run", "check:patterns"],
    VerificationClass.Static,
    VerificationCapability.SourcePolicy,
  ),
  SetupTests: phase(
    "setup-tests",
    "setup tests",
    "nub",
    ["run", "test:setup"],
    VerificationClass.SafetyIntegration,
    VerificationCapability.SetupPortability,
  ),
  Typecheck: phase(
    "typecheck",
    "typecheck",
    "nub",
    ["run", "typecheck"],
    VerificationClass.Static,
    VerificationCapability.TypeSafety,
  ),
  TypeAwareLint: phase(
    "type-aware-lint",
    "type-aware lint",
    "nub",
    ["run", "lint:type"],
    VerificationClass.Static,
    VerificationCapability.TypeSafety,
  ),
  Build: phase(
    "build",
    "extension build",
    "nub",
    ["run", "build"],
    VerificationClass.Packaging,
    VerificationCapability.ExtensionIntegrity,
  ),
  InstallReadiness: phase(
    "install-readiness",
    "install readiness",
    "scripts/node-run.sh",
    ["scripts/verify-install.mjs"],
    VerificationClass.Packaging,
    VerificationCapability.InstallIntegrity,
  ),
  UnitTests: phase(
    "unit-tests",
    "unit tests",
    "nub",
    ["run", "test:unit"],
    VerificationClass.Contract,
    VerificationCapability.RuntimeBehavior,
  ),
  SafeUnitTests: phase(
    "unit-tests",
    "unit tests (one worker)",
    "nub",
    ["run", "test:safe"],
    VerificationClass.SafetyIntegration,
    VerificationCapability.RuntimeBehavior,
  ),
});

export const STANDARD_VERIFICATION_PHASES = Object.freeze([
  VerificationPhase.SetupTests,
  VerificationPhase.Typecheck,
  VerificationPhase.PatternCheck,
  VerificationPhase.EffectV4Readiness,
  VerificationPhase.Build,
  VerificationPhase.InstallReadiness,
  VerificationPhase.UnitTests,
]);

export const SAFE_VERIFICATION_PHASES = Object.freeze([
  VerificationPhase.Format,
  VerificationPhase.Typecheck,
  VerificationPhase.TypeAwareLint,
  VerificationPhase.PatternCheck,
  VerificationPhase.EffectV4Readiness,
  VerificationPhase.SafeUnitTests,
  VerificationPhase.Build,
]);

export function verificationPhaseById(id, phases = STANDARD_VERIFICATION_PHASES) {
  return phases.find((candidate) => candidate.id === id);
}
