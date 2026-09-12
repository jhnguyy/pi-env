import { describe, expect, it, vi } from "vitest";
import { runPlan } from "../verification-runner.mjs";

const phases = [
  { id: "first", label: "first phase", command: "one", args: ["a"] },
  { id: "second", label: "second phase", command: "two", args: ["b", "c"] },
];

describe("verification runner", () => {
  it("returns 1 for start errors", () => {
    const error = new Error("missing command");
    expect(
      runPlan([phases[0]], { name: "verify:test", run: () => ({ error }), logError: () => {} }),
    ).toBe(1);
  });

  it("returns non-zero exit status", () => {
    expect(runPlan([phases[0]], { run: () => ({ status: 7 }), logError: () => {} })).toBe(7);
  });


  it("stops on the first failure", () => {
    const run = vi.fn(() => ({ status: 5 }));
    expect(runPlan(phases, { run, logError: () => {} })).toBe(5);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("one", ["a"], { stdio: "inherit" });
  });
});
