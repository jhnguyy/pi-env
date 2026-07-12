import { describe, expect, it } from "vitest";
import { SAFE_VERIFICATION_PHASES, runSafeVerificationPlan } from "../safe-verification-plan.mjs";

describe("safe verification plan", () => {
  it("keeps heavyweight phases in a deterministic sequential order", () => {
    const calls = [];
    const exitCode = runSafeVerificationPlan(SAFE_VERIFICATION_PHASES, (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0 };
    });

    expect(exitCode).toBe(0);
    expect(SAFE_VERIFICATION_PHASES.map((phase) => phase.id)).toEqual([
      "format-check", "typecheck", "type-aware-lint", "unit-tests", "build",
    ]);
    expect(calls).toEqual([
      "nub run format:check", "nub run typecheck", "nub run lint:type", "nub run test:safe", "nub run build",
    ]);
  });
});
