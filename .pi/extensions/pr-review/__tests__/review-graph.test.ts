import { DagDependencyMode } from "../../../../src/dag/index.js";
import { describe, expect, it } from "vitest";
import {
  ReviewFanoutNodes,
  ReviewRoles,
  ReviewerNodes,
  compileReviewGraph,
  type ReviewRoleAssignments,
} from "../review-graph";

const assignments = Object.fromEntries(
  ReviewRoles.map((role, index) => [
    role,
    { model: index % 2 ? "provider-b/model" : "provider-a/model", reasoning: "high" },
  ]),
) as ReviewRoleAssignments;
const tools = {
  deck: "review_deck_run",
  read: [
    "review_read_run",
    "review_grep_run",
    "review_find_run",
    "review_list_run",
    "review_diff_run",
    "review_changed_files_run",
  ],
  planSubmission: "submit_review_plan_run",
  reviewerSubmission: "submit_reviewer_result_run",
  resultReferences: "review_result_refs_run",
  synthesisSubmission: "submit_review_synthesis_run",
};

describe("fixed PR review graph", () => {
  it("compiles one reading plan, five focused reviewers, one whole-change reviewer, and synthesis", () => {
    const graph = compileReviewGraph({
      runId: "review-run",
      cwd: "/workspace",
      assignments,
      tools,
    });
    expect(graph.concurrency).toBe(7);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      ...ReviewFanoutNodes.map((node) => node.nodeId),
      "synthesis",
    ]);
    const synthesis = graph.nodes.find((node) => node.id === "synthesis")!;
    expect(graph.nodes.every((node) => node.executor.payload.maxTurns === undefined)).toBe(true);
    expect(synthesis.dependencies).toHaveLength(7);
    expect(
      synthesis.dependencies.every((dependency) => dependency.mode === DagDependencyMode.Settled),
    ).toBe(true);
    expect(synthesis.completionGuard?.dependencyIds).toEqual(
      ReviewerNodes.map((node) => node.nodeId),
    );
  });

  it("gives each child only explicit confined review tools and no spawning authority", () => {
    const graph = compileReviewGraph({
      runId: "review-run",
      cwd: "/workspace",
      assignments,
      tools,
    });
    for (const node of graph.nodes) {
      const payload = node.executor.payload;
      expect(payload.workspace).toEqual({ cwd: "/workspace", access: "read" });
      expect(payload.tools).not.toContain("bash");
      expect(payload.tools).not.toContain("read");
      expect(payload.tools).not.toContain("write");
      expect(payload.tools).not.toContain("subagent");
      expect(payload.tools).not.toContain("review");
      expect(payload.tools).not.toContain("pr_review");
      expect(payload.agent).toBeUndefined();
      expect(payload.reasoning).toBe("high");
    }
  });
});
