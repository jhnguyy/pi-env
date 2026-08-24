import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DagDependencyMode,
  DagExecutorKind,
  DagNodeStatus,
  materializeDagTextArtifact,
  publishDagSubagentTextResult,
} from "../../../../src/dag/index.js";
import { sha256 } from "../core";
import {
  ReviewEvidenceCoverageOutput,
  ReviewEvidenceOutputs,
  ReviewEvidenceResolverKey,
  makeReviewEvidenceResolverExecutor,
} from "../evidence-resolver";
import type { ReviewPlan } from "../schema";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "review-evidence-"));
  roots.push(root);
  const worktree = path.join(root, "worktree");
  const artifacts = path.join(root, "review-artifacts");
  const dagArtifacts = path.join(root, "dag-artifacts");
  mkdirSync(worktree);
  mkdirSync(artifacts);
  mkdirSync(dagArtifacts);
  writeFileSync(path.join(worktree, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  execFileSync("git", ["init", "-q"], { cwd: worktree });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: worktree });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: worktree });
  execFileSync("git", ["add", "a.ts"], { cwd: worktree });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: worktree });
  const headOid = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
  }).trim();
  const diff =
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-export const a = 0;\n+export const a = 1;\n+export const b = 2;\n";
  const diffPath = path.join(artifacts, "diff.patch");
  writeFileSync(diffPath, diff);
  return { root, worktree, artifacts, dagArtifacts, headOid, diff, diffPath };
}

function plan(evidence: ReviewPlan["evidence"], pathName = "a.ts"): ReviewPlan {
  return {
    goal: "Change exports.",
    goalAssessment: "The snapshot changes exports.",
    risk: "low",
    riskReasons: [],
    cohorts: [{ label: "code", purpose: "review", paths: [pathName] }],
    files: [{ path: pathName, attention: "normal", role: "implementation" }],
    evidence,
  };
}

async function execute(input: {
  fixture: ReturnType<typeof fixture>;
  plan: ReviewPlan;
  changedPaths?: string[];
  diffHash?: string;
  reviewerContextWindow?: number;
}) {
  const runId = "review-run";
  const planOutputs = await Effect.runPromise(
    publishDagSubagentTextResult(
      input.fixture.dagArtifacts,
      runId,
      "reading-plan",
      "plan-attempt",
      "reading_plan",
      JSON.stringify(input.plan),
    ),
  );
  const node = {
    id: "evidence-resolver",
    executor: {
      kind: DagExecutorKind.Materialize,
      key: ReviewEvidenceResolverKey,
      payload: {
        v: 1,
        snapshotId: "snapshot",
        headOid: input.fixture.headOid,
        diffHash: input.diffHash ?? sha256(input.fixture.diff),
        worktree: input.fixture.worktree,
        diffPath: input.fixture.diffPath,
        changedPaths: input.changedPaths ?? ["a.ts"],
        planOutputName: "reading_plan",
        reviewerContextWindow: input.reviewerContextWindow ?? 272_000,
      },
    },
    dependencies: [{ nodeId: "reading-plan", mode: DagDependencyMode.Required }],
  };
  const executor = makeReviewEvidenceResolverExecutor({
    artifactRoot: input.fixture.dagArtifacts,
  });
  return Effect.runPromise(
    Effect.scoped(
      executor({
        runId,
        node,
        attemptId: "resolver-attempt",
        attemptOrdinal: 1,
        graphState: {
          runId,
          nodes: [
            {
              nodeId: "reading-plan",
              status: DagNodeStatus.Succeeded,
              outputs: planOutputs,
            },
          ],
        },
      } as any),
    ),
  );
}

describe("pull request evidence resolver", () => {
  it("publishes one verified dossier digest and bounded named chunks", async () => {
    const f = fixture();
    const outputs = await execute({
      fixture: f,
      plan: plan([
        { kind: "file", path: "a.ts", startLine: 1, endLine: 2, purpose: "source" },
        { kind: "diff", path: "a.ts", startLine: 1, endLine: 7, purpose: "patch" },
      ]),
    });
    expect(Object.keys(outputs).sort()).toEqual([...ReviewEvidenceOutputs].sort());
    const coverage = await Effect.runPromise(
      materializeDagTextArtifact(
        f.dagArtifacts,
        outputs[ReviewEvidenceCoverageOutput],
        {
          runId: "review-run",
          producerNodeId: "evidence-resolver",
          outputName: ReviewEvidenceCoverageOutput,
        },
      ),
    );
    expect(JSON.parse(coverage.text)).toMatchObject({
      v: 1,
      snapshotId: "snapshot",
      references: 2,
      chunks: 1,
      omissions: [],
    });
    expect(JSON.parse(coverage.text).digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    {
      name: "reversed range",
      prepare: (f: ReturnType<typeof fixture>) => ({
        fixture: f,
        plan: plan([
          { kind: "file" as const, path: "a.ts", startLine: 2, endLine: 1, purpose: "bad" },
        ]),
      }),
    },
    {
      name: "missing file",
      prepare: (f: ReturnType<typeof fixture>) => ({
        fixture: f,
        changedPaths: ["missing.ts"],
        plan: plan(
          [
            {
              kind: "file" as const,
              path: "missing.ts",
              startLine: 1,
              endLine: 1,
              purpose: "missing",
            },
          ],
          "missing.ts",
        ),
      }),
    },
    {
      name: "traversal",
      prepare: (f: ReturnType<typeof fixture>) => ({
        fixture: f,
        changedPaths: ["../outside.ts"],
        plan: plan(
          [
            {
              kind: "file" as const,
              path: "../outside.ts",
              startLine: 1,
              endLine: 1,
              purpose: "escape",
            },
          ],
          "../outside.ts",
        ),
      }),
    },
    {
      name: "unplanned path",
      prepare: (f: ReturnType<typeof fixture>) => ({
        fixture: f,
        plan: plan([
          {
            kind: "file" as const,
            path: "other.ts",
            startLine: 1,
            endLine: 1,
            purpose: "unplanned",
          },
        ]),
      }),
    },
    {
      name: "snapshot mismatch",
      prepare: (f: ReturnType<typeof fixture>) => ({
        fixture: f,
        diffHash: "0".repeat(64),
        plan: plan([
          { kind: "file" as const, path: "a.ts", startLine: 1, endLine: 1, purpose: "source" },
        ]),
      }),
    },
  ])("rejects $name without returning evidence references", async ({ prepare }) => {
    const f = fixture();
    await expect(execute(prepare(f))).rejects.toBeDefined();
  });

  it("rejects a changed worktree after snapshot preparation", async () => {
    const f = fixture();
    writeFileSync(path.join(f.worktree, "a.ts"), "changed after snapshot\n");
    await expect(
      execute({
        fixture: f,
        plan: plan([
          { kind: "file", path: "a.ts", startLine: 1, endLine: 1, purpose: "source" },
        ]),
      }),
    ).rejects.toMatchObject({ code: "snapshot-mismatch" });
  });

  it("rejects evidence that exceeds the fixed producer admission limit", async () => {
    const f = fixture();
    writeFileSync(
      path.join(f.worktree, "a.ts"),
      Array.from({ length: 1_000 }, () => "x".repeat(900)).join("\n"),
    );
    execFileSync("git", ["add", "a.ts"], { cwd: f.worktree });
    execFileSync("git", ["commit", "-qm", "large source"], { cwd: f.worktree });
    f.headOid = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: f.worktree,
      encoding: "utf8",
    }).trim();
    await expect(
      execute({
        fixture: f,
        plan: plan([
          { kind: "file", path: "a.ts", startLine: 1, endLine: 1_000, purpose: "source" },
        ]),
      }),
    ).rejects.toMatchObject({ code: "producer-overflow" });
  });

  it("rejects evidence that exceeds the reviewer context window", async () => {
    const f = fixture();
    await expect(
      execute({
        fixture: f,
        reviewerContextWindow: 4_500,
        plan: plan([
          { kind: "file", path: "a.ts", startLine: 1, endLine: 2, purpose: "source" },
        ]),
      }),
    ).rejects.toMatchObject({ code: "prompt-overflow" });
  });

  it("rejects a symlink that resolves outside the pinned worktree", async () => {
    const f = fixture();
    const outside = path.join(f.root, "outside.ts");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(f.worktree, "link.ts"));
    execFileSync("git", ["add", "link.ts"], { cwd: f.worktree });
    execFileSync("git", ["commit", "-qm", "add symlink"], { cwd: f.worktree });
    f.headOid = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: f.worktree,
      encoding: "utf8",
    }).trim();
    await expect(
      execute({
        fixture: f,
        changedPaths: ["link.ts"],
        plan: plan(
          [
            {
              kind: "file",
              path: "link.ts",
              startLine: 1,
              endLine: 1,
              purpose: "escape",
            },
          ],
          "link.ts",
        ),
      }),
    ).rejects.toMatchObject({ code: "symlink-escape" });
  });
});
