import { describe, expect, it, vi } from "vitest";
import {
  EXPLICIT_VERIFICATION_PHASES,
  SAFE_VERIFICATION_PHASES,
  STANDARD_VERIFICATION_PHASES,
  VerificationClass,
} from "../verification-phases.mjs";
import { runVerificationPhase } from "../verify-phase.mjs";

describe("verification phase registry", () => {
  it("keeps standard verification order and capability classification explicit", () => {
    expect(STANDARD_VERIFICATION_PHASES.map((phase) => phase.id)).toEqual([
      "setup-tests",
      "typecheck",
      "pattern-check",
      "dependency-check",
      "changed-code-quality",
      "license-compliance",
      "build",
      "install-readiness",
      "unit-tests",
    ]);
    expect(
      STANDARD_VERIFICATION_PHASES.every((phase) =>
        Object.values(VerificationClass).includes(phase.classification),
      ),
    ).toBe(true);
  });

  it("keeps the safe portfolio sequential and reuses shared phases", () => {
    expect(
      SAFE_VERIFICATION_PHASES.map((phase) => [phase.id, phase.command, ...phase.args]),
    ).toEqual([
      ["format-check", "nub", "run", "format:check"],
      ["typecheck", "nub", "run", "typecheck"],
      ["type-aware-lint", "nub", "run", "lint:type"],
      ["pattern-check", "nub", "run", "check:patterns"],
      ["dependency-check", "nub", "run", "check:dependencies"],
      ["changed-code-quality", "nub", "run", "quality:changed"],
      ["license-compliance", "nub", "run", "licenses:check"],
      ["unit-tests", "nub", "run", "test:safe"],
      ["build", "nub", "run", "build"],
    ]);

    for (const id of [
      "typecheck",
      "pattern-check",
      "dependency-check",
      "changed-code-quality",
      "license-compliance",
      "build",
    ]) {
      expect(SAFE_VERIFICATION_PHASES.find((phase) => phase.id === id)).toBe(
        STANDARD_VERIFICATION_PHASES.find((phase) => phase.id === id),
      );
    }
  });

  it("runs one known phase and rejects unknown phase ids", () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(runVerificationPhase("typecheck", { run, now: () => 0, log: () => {} })).toBe(0);
    expect(run).toHaveBeenCalledWith("nub", ["run", "typecheck"], { stdio: "inherit" });

    const logError = vi.fn();
    expect(runVerificationPhase("missing", { run, logError })).toBe(2);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("unknown phase"));
  });

  it("makes the slow real-workspace canary explicitly invocable only", () => {
    expect(STANDARD_VERIFICATION_PHASES.map((phase) => phase.id)).not.toContain(
      "real-workspace-semantic-canary",
    );
    expect(SAFE_VERIFICATION_PHASES.map((phase) => phase.id)).not.toContain(
      "real-workspace-semantic-canary",
    );

    const canary = EXPLICIT_VERIFICATION_PHASES.find(
      (phase) => phase.id === "real-workspace-semantic-canary",
    );
    expect([canary?.command, ...(canary?.args ?? [])]).toEqual([
      "nub",
      "run",
      "test:e2e:real-workspace-canary",
    ]);

    const run = vi.fn(() => ({ status: 0 }));
    expect(
      runVerificationPhase("real-workspace-semantic-canary", { run, now: () => 0, log: () => {} }),
    ).toBe(0);
    expect(run).toHaveBeenCalledWith(
      "nub",
      ["run", "test:e2e:real-workspace-canary"],
      { stdio: "inherit" },
    );
  });
});
