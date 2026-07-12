import { describe, expect, it, vi } from "vitest";
import { listPlan, runPlan } from "../verification-runner.mjs";

const phases = [
  { id: "first", label: "first phase", command: "one", args: ["a"] },
  { id: "second", label: "second phase", command: "two", args: ["b", "c"] },
];

describe("verification runner", () => {
  it("lists phases in order", () => {
    expect(listPlan(phases)).toEqual([
      "first: first phase — one a",
      "second: second phase — two b c",
    ]);
  });

  it("returns 1 for start errors", () => {
    const error = new Error("missing command");
    expect(
      runPlan([phases[0]], { name: "verify:test", run: () => ({ error }), logError: () => {} }),
    ).toBe(1);
  });

  it("returns non-zero exit status", () => {
    expect(runPlan([phases[0]], { run: () => ({ status: 7 }), logError: () => {} })).toBe(7);
  });

  it("reports deterministic elapsed timing for each completed phase", () => {
    const log = vi.fn();
    const now = vi
      .fn()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112)
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(235);

    expect(runPlan(phases, { run: () => ({ status: 0 }), now, log })).toBe(0);
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      "\n==> first phase",
      "<== first phase passed in 12 ms",
      "\n==> second phase",
      "<== second phase passed in 35 ms",
    ]);
  });

  it("stops on the first failure", () => {
    const run = vi.fn(() => ({ status: 5 }));
    expect(runPlan(phases, { run, logError: () => {} })).toBe(5);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("one", ["a"], { stdio: "inherit" });
  });
});
