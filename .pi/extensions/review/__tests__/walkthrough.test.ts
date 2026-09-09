import { describe, expect, it } from "vitest";
import { applyDecision, findingsForDecision, isDegraded } from "../decision";
import { walkthroughSummary } from "../walkthrough";
import type { ReviewState } from "../core";

function state(): ReviewState {
  return {
    snapshot: { id: "review-1", metadata: { headOid: "abc", baseOid: "def", title: "Demo", url: "u" } },
    selectedFindingIds: ["F1"],
    decisions: {},
    posts: [],
    dag: { status: "degraded", failedNodes: ["security"], malformedNodes: [], rawResultReferences: [], runId: "run" },
    result: { verdict: "degraded", coverage: { status: "degraded", succeeded: [], failed: ["security"], malformed: [] }, findings: [
      { id: "F1", severity: "serious", impact: "high", problem: "p", consequence: "c", suggestedFix: "f", file: "a.ts", line: 2, anchorValid: true, selected: true },
      { id: "F2", severity: "low", impact: "low", problem: "q", consequence: "c", suggestedFix: "f" },
    ] },
  } as unknown as ReviewState;
}

describe("review walkthrough decisions", () => {
  it("keeps defaults pending and persists explicit statuses", () => {
    const initial = state();
    expect(findingsForDecision(initial, "selected")).toHaveLength(0);
    const next = applyDecision(initial, ["F1"], "selected");
    const final = applyDecision(next, ["F2"], "deferred");
    expect(final.decisions?.F1.status).toBe("selected");
    expect(final.decisions?.F2.status).toBe("deferred");
    expect(final.selectedFindingIds).toEqual(["F1"]);
  });

  it("renders required stages in order and reports degraded evidence", () => {
    const output = walkthroughSummary(state(), true);
    expect(output.indexOf("Overview")).toBeLessThan(output.indexOf("Coverage"));
    expect(output.indexOf("Coverage")).toBeLessThan(output.indexOf("Reading plan"));
    expect(output.indexOf("Anchored findings")).toBeLessThan(output.indexOf("Unanchored findings"));
    expect(output).toContain("Pinned head: abc");
    expect(output).toContain("Degraded review acknowledgement: required");
    expect(isDegraded(state())).toBe(true);
  });

  it("rejects a finding ID owned by another review", () => {
    expect(() => applyDecision(state(), ["other"], "rejected")).toThrow("not owned by review review-1");
  });
});
