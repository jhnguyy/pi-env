import { describe, expect, it, vi } from "vitest";
import { runVerificationPhase } from "../verify-phase.mjs";

describe("verification phase registry", () => {
  it("runs one known phase and rejects unknown phase ids", () => {
    const run = vi.fn(() => ({ status: 0 }));
    expect(runVerificationPhase("typecheck", { run, now: () => 0, log: () => {} })).toBe(0);
    expect(run).toHaveBeenCalledWith("nub", ["run", "typecheck"], { stdio: "inherit" });

    const logError = vi.fn();
    expect(runVerificationPhase("missing", { run, logError })).toBe(2);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("unknown phase"));
  });
});
