import {
  DagDependencyMode,
  DagExecutorKind,
  parseDagSubagentPayload,
} from "../../../../src/dag/index.js";
import { describe, expect, it } from "vitest";
import {
  EvidenceResolverNode,
  ReviewRoles,
  ReviewerNodes,
  compileReviewGraph,
  type ReviewRoleAssignments,
} from "../review-graph";
import {
  ReviewEvidenceOutputs,
  ReviewEvidenceResolverKey,
} from "../evidence-resolver";

const assignments = Object.fromEntries(
  ReviewRoles.map((role, index) => [
    role,
    {
      model: index % 2 ? "provider-b/model" : "provider-a/model",
      reasoning: "high",
      contextWindow: 272_000,
    },
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
  resultReferences: "review_result_refs_run",
  synthesisSubmission: "submit_review_synthesis_run",
};
const evidence = {
  v: 1 as const,
  snapshotId: "snapshot",
  headOid: "head",
  diffHash: "a".repeat(64),
  worktree: "/workspace",
  diffPath: "/artifacts/diff.patch",
  changedPaths: ["a.ts"],
  planOutputName: "reading_plan",
  reviewerContextWindow: 272_000,
};
function graph(runId = "review-run") {
  return compileReviewGraph({ runId, cwd: "/workspace", assignments, tools, evidence });
}

function subagentPayload(node: ReturnType<typeof graph>["nodes"][number]) {
  return parseDagSubagentPayload(node.executor.payload);
}

describe("fixed pull request review graph", () => {
  it("orders reading plan, deterministic evidence resolution, reviewers, and synthesis", () => {
    const compiled = graph();
    expect(compiled.concurrency).toBe(6);
    expect(compiled.nodes.map((node) => node.id)).toEqual([
      "reading-plan",
      "evidence-resolver",
      "review-correctness",
      "review-intent",
      "review-maintainability",
      "review-tests",
      "review-security",
      "review-whole-change",
      "synthesis",
    ]);
    const resolver = compiled.nodes.find((node) => node.id === EvidenceResolverNode.nodeId)!;
    expect(resolver.executor).toMatchObject({
      kind: DagExecutorKind.Materialize,
      key: ReviewEvidenceResolverKey,
    });
    expect(resolver.dependencies).toEqual([
      { nodeId: "reading-plan", mode: DagDependencyMode.Required },
    ]);
    for (const reviewer of compiled.nodes.filter((node) => node.id.startsWith("review-"))) {
      expect(reviewer.dependencies).toEqual([
        { nodeId: "reading-plan", mode: DagDependencyMode.Required },
        { nodeId: EvidenceResolverNode.nodeId, mode: DagDependencyMode.Required },
      ]);
      const payload = subagentPayload(reviewer);
      expect(payload.context.outputs).toEqual(["reading_plan", ...ReviewEvidenceOutputs]);
      expect(payload.maxTurns).toBe(1);
      expect(payload.instructions).toContain(`\"role\":\"${reviewer.id.replace("review-", "")}\"`);
      expect(payload.instructions).toContain("evidenceDigest");
      expect(payload.instructions).toContain("low|medium|serious|blocking");
    }
    const synthesis = compiled.nodes.find((node) => node.id === "synthesis")!;
    expect(synthesis.dependencies.map((dependency) => dependency.nodeId)).toEqual([
      "reading-plan",
      "review-correctness",
      "review-intent",
      "review-maintainability",
      "review-tests",
      "review-security",
      "review-whole-change",
    ]);
    expect(
      synthesis.dependencies.every((dependency) => dependency.mode === DagDependencyMode.Settled),
    ).toBe(true);
    expect(synthesis.completionGuard?.dependencyIds).toEqual(
      ReviewerNodes.map((node) => node.nodeId),
    );
  });

  it("gives reviewers no model-facing tools and retains bounded plan and synthesis tools", () => {
    const compiled = graph();
    for (const node of compiled.nodes.filter(
      (candidate) => candidate.executor.kind === DagExecutorKind.Subagent,
    )) {
      const payload = subagentPayload(node);
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
            : [],
      );
      expect(payload.agent).toBeUndefined();
      expect(payload.reasoning).toBe("high");
    }
  });

  it("uses bounded unique child-session names for long run identifiers", () => {
    const names = graph(`review-${"owner-repository-".repeat(20)}`).nodes
      .filter((node) => node.executor.kind === DagExecutorKind.Subagent)
      .map((node) => {
        const payload = subagentPayload(node);
        expect(Buffer.byteLength(payload.name, "utf8")).toBeLessThanOrEqual(128);
        return payload.name;
      });
    expect(new Set(names).size).toBe(names.length);
  });
});
