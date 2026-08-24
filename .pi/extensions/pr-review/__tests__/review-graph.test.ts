import { DagDependencyMode, parseDagSubagentPayload } from "../../../../src/dag/index.js";
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
    const plan = graph.nodes.find((node) => node.id === "reading-plan")!;
    expect(plan.dependencies).toEqual([]);
    for (const reviewer of graph.nodes.filter((node) => node.id.startsWith("review-"))) {
      expect(reviewer.dependencies).toEqual([
        { nodeId: "reading-plan", mode: DagDependencyMode.Required },
      ]);
      expect(reviewer.executor.payload.context.outputs).toEqual(["reading_plan"]);
    }
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
      expect(payload.tools).toEqual(
        node.id === "reading-plan"
          ? [tools.deck, ...tools.read, tools.planSubmission]
          : node.id === "synthesis"
            ? [tools.deck, tools.resultReferences, tools.synthesisSubmission]
            : [tools.deck, ...tools.read, tools.reviewerSubmission],
      );
      expect(payload.agent).toBeUndefined();
      expect(payload.reasoning).toBe("high");
    }
  });

  it("uses bounded unique child-session names for long run identifiers", () => {
    const graph = compileReviewGraph({
      runId: `review-${"owner-repository-".repeat(20)}`,
      cwd: "/workspace",
      assignments,
      tools,
    });
    const names = graph.nodes.map((node) => {
      const payload = parseDagSubagentPayload(node.executor.payload);
      expect(Buffer.byteLength(payload.name, "utf8")).toBeLessThanOrEqual(128);
      return payload.name;
    });
    expect(new Set(names).size).toBe(names.length);
  });
});
