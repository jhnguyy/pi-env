import { describe, expect, it, vi } from "vitest";
import {
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
      "effect-v4-readiness",
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

  it("reuses shared phase objects across standard and safe portfolios", () => {
    const sharedIds = ["typecheck", "pattern-check", "effect-v4-readiness", "build"];
    for (const id of sharedIds) {
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
});
