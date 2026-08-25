import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DagNodeStatus,
  publishDagSubagentTextResult,
  type DagSessionReconstruction,
} from "../../../../src/dag/index.js";
import {
  admitReviewerDossier,
  MaxReviewerDossierBytes,
  serializeReviewerDossierContext,
} from "../reviewer-dossier";
import {
  ReviewRoles,
  ReviewerNodes,
  compileReviewGraph,
  type ReviewRoleAssignments,
} from "../review-graph";

const Digest = "a".repeat(64);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const assignments = Object.fromEntries(
  ReviewRoles.map((role) => [role, { model: "provider/model", contextWindow: 272_000 }]),
) as ReviewRoleAssignments;

function graph(root: string) {
  return compileReviewGraph({
    runId: "review-dossier-contract",
    cwd: root,
    assignments,
    tools: {
      deck: "deck",
      read: [],
      planSubmission: "plan",
      resultReferences: "references",
      synthesisSubmission: "synthesis",
    },
    evidence: {
      v: 1,
      snapshotId: "snapshot",
      headOid: "head",
      diffHash: "b".repeat(64),
      worktree: root,
      diffPath: path.join(root, "diff"),
      changedPaths: ["a.ts"],
      planOutputName: "reading_plan",
      reviewerContextWindow: 272_000,
    },
  });
}

function output(role: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    role,
    evidenceDigest: Digest,
    verdict: "Reviewed.",
    findings: [],
    ...overrides,
  });
}

async function fixture(
  overrides: Readonly<
    Record<
      string,
      {
        status?: "failed";
        text?: string;
        outputName?: string;
        extra?: boolean;
        tamper?: boolean;
        provenance?: boolean;
      }
    >
  > = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "reviewer-dossier-"));
  roots.push(root);
  const compiled = graph(root);
  const states: any[] = [];
  for (const node of ReviewerNodes) {
    const override = overrides[node.nodeId];
    if (override?.status === "failed") {
      states.push({ nodeId: node.nodeId, status: DagNodeStatus.Failed, failure: {} });
      continue;
    }
    const outputName = override?.outputName ?? node.outputName;
    const outputs: Record<string, unknown> = {
      ...(await Effect.runPromise(
        publishDagSubagentTextResult(
          root,
          compiled.runId,
          node.nodeId,
          `attempt-${node.nodeId}`,
          outputName,
          override?.text ?? output(node.role),
        ),
      )),
    };
    if (override?.extra) {
      Object.assign(
        outputs,
        await Effect.runPromise(
          publishDagSubagentTextResult(
            root,
            compiled.runId,
            node.nodeId,
            `attempt-${node.nodeId}`,
            "unexpected",
            "extra",
          ),
        ),
      );
    }
    if (override?.provenance) {
      const reference = outputs[outputName] as any;
      outputs[outputName] = { ...reference, producerNodeId: "review-security" };
    }
    if (override?.tamper) {
      const reference = outputs[outputName] as any;
      writeFileSync(path.join(root, reference.path), "tampered");
    }
    states.push({ nodeId: node.nodeId, status: DagNodeStatus.Succeeded, outputs });
  }
  // State serialization order is not an admission-order authority.
  states.reverse();
  return {
    root,
    reconstruction: {
      graph: compiled,
      state: { runId: compiled.runId, nodes: states },
    } as unknown as DagSessionReconstruction,
  };
}

describe("reviewer dossier admission contract", () => {
  it("admits strict reviewers once in graph topology order", async () => {
    const f = await fixture();
    const dossier = await admitReviewerDossier({
      artifactRoot: f.root,
      reconstruction: f.reconstruction,
      expectedEvidenceDigest: Digest,
    });
    expect(dossier.admitted.map((item) => item.nodeId)).toEqual(
      ReviewerNodes.map((node) => node.nodeId),
    );
    expect(dossier.raw.map((item) => item.reference)).toHaveLength(ReviewerNodes.length);
    expect(dossier.failed).toEqual([]);
    expect(dossier.malformed).toEqual([]);
  });

  it("classifies wrong digest, wrong role, and malformed JSON while preserving verified raw references", async () => {
    const f = await fixture({
      "review-correctness": { text: output("correctness", { evidenceDigest: "0".repeat(64) }) },
      "review-intent": { text: output("security") },
      "review-maintainability": { text: "not-json" },
    });
    const dossier = await admitReviewerDossier({
      artifactRoot: f.root,
      reconstruction: f.reconstruction,
      expectedEvidenceDigest: Digest,
    });
    expect(dossier.malformed).toEqual([
      "review-correctness",
      "review-intent",
      "review-maintainability",
    ]);
    expect(dossier.raw).toHaveLength(ReviewerNodes.length);
  });

  it("fails closed for tampered artifacts and wrong provenance", async () => {
    const f = await fixture({
      "review-correctness": { text: output("correctness"), tamper: true },
      "review-intent": { text: output("intent"), provenance: true },
    });
    const dossier = await admitReviewerDossier({
      artifactRoot: f.root,
      reconstruction: f.reconstruction,
      expectedEvidenceDigest: Digest,
    });
    expect(dossier.malformed.slice(0, 2)).toEqual(["review-correctness", "review-intent"]);
    expect(dossier.raw.map((item) => item.nodeId)).not.toContain("review-correctness");
    expect(dossier.raw.map((item) => item.nodeId)).not.toContain("review-intent");
  });

  it("degrades excess valid reviewers instead of failing aggregate admission", async () => {
    const long = `x${"\n".repeat(19_998)}`;
    const findings = Array.from({ length: 2 }, () => ({
      severity: "medium",
      impact: "medium",
      problem: long,
      consequence: long,
      suggestedFix: long,
    }));
    const f = await fixture(
      Object.fromEntries(
        ReviewerNodes.map((node) => [node.nodeId, { text: output(node.role, { findings }) }]),
      ),
    );
    const dossier = await admitReviewerDossier({
      artifactRoot: f.root,
      reconstruction: f.reconstruction,
      expectedEvidenceDigest: Digest,
    });
    expect(dossier.admitted.length).toBeGreaterThan(0);
    expect(dossier.admitted.length).toBeLessThan(ReviewerNodes.length);
    expect(dossier.malformed).toHaveLength(ReviewerNodes.length - dossier.admitted.length);
    expect(() => serializeReviewerDossierContext(dossier)).not.toThrow();
  });

  it("applies the tool limit after JSON escaping", () => {
    const text = '"'.repeat(Math.floor(MaxReviewerDossierBytes / 2));
    expect(() =>
      serializeReviewerDossierContext({
        admitted: [
          {
            nodeId: "review-correctness",
            outputName: "correctness_review",
            reference: {} as any,
            text,
            reviewer: JSON.parse(output("correctness")),
          },
        ],
        raw: [],
        failed: [],
        malformed: [],
      }),
    ).toThrow("Reviewer result context exceeds the absolute byte limit.");
  });

  it("classifies failed, missing, wrongly named, and multiple outputs deterministically", async () => {
    const f = await fixture({
      "review-correctness": { status: "failed" },
      "review-intent": { text: output("intent"), outputName: "wrong" },
      "review-maintainability": { text: output("maintainability"), extra: true },
    });
    const missing = f.reconstruction.state.nodes.find(
      (node) => node.nodeId === "review-tests" && node.status === DagNodeStatus.Succeeded,
    ) as any;
    missing.outputs = {};
    const dossier = await admitReviewerDossier({
      artifactRoot: f.root,
      reconstruction: f.reconstruction,
      expectedEvidenceDigest: Digest,
    });
    expect(dossier.failed).toEqual(["review-correctness"]);
    expect(dossier.malformed).toEqual(["review-intent", "review-maintainability", "review-tests"]);
    expect(dossier.raw.filter((item) => item.nodeId === "review-maintainability")).toHaveLength(2);
  });
});
