import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Data, Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DagNodeStatus,
  DagRunOutcome,
  publishDagSubagentTextResult,
  type DagSessionReconstruction,
  type ValidatedDagDefinition,
} from "../../../../src/dag/index.js";
import { reconstructReviewDagState, runReviewDag } from "../review-dag-runner";
import { ReviewRoles, compileReviewGraph, type ReviewRoleAssignments } from "../review-graph";
import type { ReviewState } from "../schema";

class TestAppendFailure extends Data.TaggedError("TestAppendFailure")<{
  readonly message: string;
}> {}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  artifactRoot: string;
  deckPath: string;
  state: ReviewState;
  ctx: any;
} {
  const root = mkdtempSync(path.join(tmpdir(), "pr-review-dag-runner-"));
  roots.push(root);
  const worktree = path.join(root, "worktree");
  const artifacts = path.join(root, "review-artifacts");
  const sessionDir = path.join(root, "session");
  const artifactRoot = path.join(sessionDir, "dag-artifacts", "parent");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(path.join(worktree, "a.ts"), "export const value = 1;\n");
  const diffPath = path.join(artifacts, "diff.patch");
  writeFileSync(
    diffPath,
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n",
  );
  const deckPath = path.join(artifacts, "review-deck.json");
  writeFileSync(deckPath, JSON.stringify({ version: 1, snapshotId: "review" }));
  const state: ReviewState = {
    snapshot: {
      id: "review",
      artifactDir: artifacts,
      worktree,
      diffPath,
      diffHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: {
        owner: "o",
        repo: "r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        baseOid: "base",
        headOid: "head",
        changedFiles: [{ path: "a.ts" }],
      },
    },
    selectedFindingIds: [],
    posts: [],
  };
  return {
    root,
    artifactRoot,
    deckPath,
    state,
    ctx: {
      cwd: root,
      sessionManager: {
        getSessionDir: () => sessionDir,
        getSessionId: () => "parent",
      },
    },
  };
}

const assignments = Object.fromEntries(
  ReviewRoles.map((role, index) => [
    role,
    { model: index % 2 ? "provider-b/model" : "provider-a/model", reasoning: "high" },
  ]),
) as ReviewRoleAssignments;

function plan(): string {
  return JSON.stringify({
    goal: "Change the exported value.",
    goalAssessment: "The diff changes the value.",
    risk: "low",
    riskReasons: [],
    cohorts: [{ label: "code", purpose: "implementation", paths: ["a.ts"] }],
    files: [{ path: "a.ts", attention: "normal", role: "implementation" }],
  });
}
function reviewer(role: string): string {
  return JSON.stringify({
    role,
    verdict: `${role} reviewed`,
    findings:
      role === "correctness"
        ? [
            {
              severity: "serious",
              impact: "high",
              file: "a.ts",
              side: "RIGHT",
              line: 1,
              problem: "The value is wrong.",
              consequence: "Callers receive the wrong value.",
              suggestedFix: "Use the required value.",
            },
          ]
        : [],
  });
}
function synthesis(): string {
  return JSON.stringify({
    verdict: "One serious issue was found.",
    coverage: { status: "complete", succeeded: [], failed: [], malformed: [] },
    findings: [
      {
        severity: "serious",
        impact: "high",
        file: "a.ts",
        side: "RIGHT",
        line: 1,
        problem: "The value is wrong.",
        consequence: "Callers receive the wrong value.",
        suggestedFix: "Use the required value.",
        sourceReviewers: ["correctness"],
        agreement: 1,
      },
    ],
  });
}

async function reconstructionFor(
  artifactRoot: string,
  graph: ValidatedDagDefinition<any>,
  overrides: Readonly<Record<string, string | "failed">>,
): Promise<DagSessionReconstruction> {
  const defaults: Record<string, string> = {
    "reading-plan": plan(),
    "review-correctness": reviewer("correctness"),
    "review-intent": reviewer("intent"),
    "review-maintainability": reviewer("maintainability"),
    "review-tests": reviewer("tests"),
    "review-security": reviewer("security"),
    "review-whole-change": reviewer("whole-change"),
    synthesis: synthesis(),
  };
  const nodes = [] as any[];
  for (const node of graph.nodes) {
    const value = overrides[node.id] ?? defaults[node.id];
    if (value === "failed") {
      nodes.push({ nodeId: node.id, status: DagNodeStatus.Failed, failure: { message: "failed" } });
      continue;
    }
    const outputName = node.executor.payload.output.name;
    const outputs = await Effect.runPromise(
      publishDagSubagentTextResult(
        artifactRoot,
        graph.runId,
        node.id,
        `attempt-${node.id}`,
        outputName,
        value,
      ),
    );
    nodes.push({ nodeId: node.id, status: DagNodeStatus.Succeeded, outputs });
  }
  return {
    graph,
    graphId: "graph-id",
    state: { runId: graph.runId, nodes },
    terminalOutcome: Object.values(overrides).includes("failed")
      ? DagRunOutcome.Failed
      : DagRunOutcome.Succeeded,
    transitions: [],
    attempts: [],
    persistedEntryCount: 1,
    recoveredFromProcessLoss: false,
  } as unknown as DagSessionReconstruction;
}

function serviceFor(
  artifactRoot: string,
  overrides: Readonly<Record<string, string | "failed">>,
  onSubmit?: (authority: unknown) => void,
): any {
  let ready: Promise<DagSessionReconstruction>;
  return {
    submit: (graph: ValidatedDagDefinition<any>, authority: unknown) =>
      Effect.sync(() => {
        onSubmit?.(authority);
        ready = reconstructionFor(artifactRoot, graph, overrides);
        return {
          accepted: Effect.void,
          snapshot: Effect.promise(() => ready).pipe(Effect.map((value) => value as any)),
          await: Effect.promise(() => ready).pipe(Effect.map((value) => value as any)),
          cancel: Effect.promise(() => ready).pipe(Effect.map((value) => value as any)),
        };
      }),
    reconstruct: () => Effect.promise(() => ready),
  };
}

function piEvents(): any {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    events: {
      emit(event: string, data: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(data);
      },
      on(event: string, handler: (data: unknown) => void) {
        const listeners = handlers.get(event) ?? new Set();
        listeners.add(handler);
        handlers.set(event, listeners);
        return () => listeners.delete(handler);
      },
    },
  };
}

describe("DAG-backed PR review runner", () => {
  it("unregisters run-scoped tools when the first state save fails", async () => {
    const f = fixture();
    const pi = piEvents();
    let registered = 0;
    let unregistered = 0;
    pi.events.on("agent-tools:register", () => registered++);
    pi.events.on("agent-tools:unregister", () => unregistered++);
    await expect(
      runReviewDag({
        pi,
        ctx: f.ctx,
        service: serviceFor(f.artifactRoot, {}),
        assignments,
        deckPath: f.deckPath,
        state: f.state,
        save: () => {
          throw new Error("state append failed");
        },
      }),
    ).rejects.toThrow("state append failed");
    expect(registered).toBeGreaterThan(0);
    expect(unregistered).toBe(registered);
  });

  it("preserves valid findings and reports failed and malformed reviewer paths as degraded", async () => {
    const f = fixture();
    const saved: ReviewState[] = [];
    const progress: unknown[] = [];
    let authority: any;
    const result = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service: serviceFor(
        f.artifactRoot,
        {
          "review-maintainability": reviewer("security"),
          "review-security": "failed",
        },
        (submittedAuthority) => (authority = submittedAuthority),
      ),
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: (state) => saved.push(structuredClone(state)),
      onProgress: (update) => progress.push(update),
    });
    expect(authority.budget).toEqual({
      maxTotalTokens: 55_000_000,
      maxCost: 70,
      maxTurns: 600,
    });
    expect(progress).not.toHaveLength(0);
    expect(result.dag).toMatchObject({
      status: "degraded",
      failedNodes: ["review-security"],
      malformedNodes: ["review-maintainability"],
    });
    expect(result.dag?.rawResultReferences).toHaveLength(5);
    expect(result.plan?.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(result.result?.coverage).toEqual({
      status: "degraded",
      succeeded: ["correctness", "intent", "tests", "whole-change"],
      failed: ["security"],
      malformed: ["maintainability"],
    });
    expect(result.result?.findings[0]).toMatchObject({
      id: "F1",
      anchorValid: true,
      sourceReviewers: ["correctness"],
      agreement: 1,
    });
    expect(
      saved.at(-1)?.dag?.rawResultReferences.every((reference) => !reference.path.includes("{")),
    ).toBe(true);
  });

  it("reports a failed synthesis node while preserving reviewer findings", async () => {
    const f = fixture();
    const result = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service: serviceFor(f.artifactRoot, { synthesis: "failed" }),
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: () => {},
    });
    expect(result.dag).toMatchObject({
      status: "degraded",
      failedNodes: ["synthesis"],
    });
    expect(result.result?.findings[0]?.problem).toBe("The value is wrong.");
  });

  it("rejects synthesis provenance that is not present in the claimed reviewer output", async () => {
    const f = fixture();
    const invented = JSON.parse(synthesis());
    invented.findings[0].problem = "The synthesis invented this problem.";
    const result = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service: serviceFor(f.artifactRoot, { synthesis: JSON.stringify(invented) }),
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: () => {},
    });
    expect(result.dag?.status).toBe("degraded");
    expect(result.result?.verdict).toContain("Reviewer synthesis failed");
    expect(result.result?.findings[0]?.problem).toBe("The value is wrong.");
    expect(result.result?.findings[0]).toMatchObject({
      sourceReviewers: ["correctness"],
      agreement: 1,
    });
  });

  it("deduplicates fallback findings by fields instead of JSON property order", async () => {
    const f = fixture();
    const reordered = JSON.stringify({
      role: "intent",
      verdict: "intent reviewed",
      findings: [
        {
          suggestedFix: "Use the required value.",
          consequence: "Callers receive the wrong value.",
          problem: "The value is wrong.",
          line: 1,
          side: "RIGHT",
          file: "a.ts",
          impact: "high",
          severity: "serious",
        },
      ],
    });
    const invented = JSON.parse(synthesis());
    invented.findings[0].problem = "Force fallback.";
    const result = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service: serviceFor(f.artifactRoot, {
        "review-intent": reordered,
        synthesis: JSON.stringify(invented),
      }),
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: () => {},
    });
    expect(result.result?.findings).toHaveLength(1);
    expect(result.result?.findings[0]).toMatchObject({
      sourceReviewers: ["correctness", "intent"],
      agreement: 2,
    });
  });

  it("fails when every reviewer output is malformed but preserves every raw reference", async () => {
    const f = fixture();
    const malformed = Object.fromEntries(
      [
        "review-correctness",
        "review-intent",
        "review-maintainability",
        "review-tests",
        "review-security",
        "review-whole-change",
      ].map((nodeId) => [nodeId, "not-json"]),
    );
    const saved: ReviewState[] = [];
    await expect(
      runReviewDag({
        pi: piEvents(),
        ctx: f.ctx,
        service: serviceFor(f.artifactRoot, malformed),
        assignments,
        deckPath: f.deckPath,
        state: f.state,
        save: (state) => saved.push(structuredClone(state)),
      }),
    ).rejects.toThrow(/All PR reviewers failed or returned malformed output/);
    expect(saved.at(-1)?.dag).toMatchObject({ status: "failed" });
    expect(saved.at(-1)?.dag?.rawResultReferences).toHaveLength(6);
    expect(saved.at(-1)?.dag?.malformedNodes).toHaveLength(6);
  });

  it("rebuilds terminal plan, findings, selection, and metrics from artifact references", async () => {
    const f = fixture();
    const service = serviceFor(f.artifactRoot, {});
    const handle = (await Effect.runPromise(
      service.submit(
        compileReviewGraph({
          runId: "pr-review-review",
          cwd: f.state.snapshot.worktree,
          assignments,
          tools: {
            deck: "review_deck_test",
            read: [],
            planSubmission: "submit_plan_test",
            reviewerSubmission: "submit_result_test",
            resultReferences: "review_refs_test",
            synthesisSubmission: "submit_synthesis_test",
          },
        }),
      ),
    )) as any;
    await Effect.runPromise(handle.await);
    const reconstruction = (await Effect.runPromise(
      service.reconstruct(),
    )) as DagSessionReconstruction;
    const rebuilt = await reconstructReviewDagState({
      ctx: f.ctx,
      service,
      state: {
        ...f.state,
        dag: {
          runId: reconstruction.graph.runId,
          startedAt: new Date(Date.now() - 10).toISOString(),
          status: "running",
          rawResultReferences: [],
        },
      },
      reconstruction,
    });
    expect(rebuilt.plan?.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(rebuilt.result?.findings[0]).toMatchObject({ id: "F1", anchorValid: true });
    expect(rebuilt.selectedFindingIds).toEqual(["F1"]);
    expect(rebuilt.metrics).toMatchObject({ reviewersSucceeded: 6, findings: 1 });
  });

  it("records a failed run when the session graph append rejects submission", async () => {
    const f = fixture();
    const saved: ReviewState[] = [];
    const service = {
      submit: () => Effect.fail(new TestAppendFailure({ message: "session graph append failed" })),
      reconstruct: () => Effect.die("reconstruction must not run"),
    };
    await expect(
      runReviewDag({
        pi: piEvents(),
        ctx: f.ctx,
        service: service as any,
        assignments,
        deckPath: f.deckPath,
        state: f.state,
        save: (state) => saved.push(structuredClone(state)),
      }),
    ).rejects.toThrow(/session graph append failed/);
    expect(saved.at(-1)?.dag).toMatchObject({
      status: "failed",
      error: "session graph append failed",
      rawResultReferences: [],
    });
  });

  it("cancels the shared run when the caller signal aborts", async () => {
    const f = fixture();
    const saved: ReviewState[] = [];
    let cancelled = false;
    let graph: ValidatedDagDefinition<any>;
    const service = {
      submit: (submitted: ValidatedDagDefinition<any>) =>
        Effect.sync(() => {
          graph = submitted;
          return {
            accepted: Effect.void,
            snapshot: Effect.never,
            await: Effect.never,
            cancel: Effect.sync(() => {
              cancelled = true;
              return {} as any;
            }),
          };
        }),
      reconstruct: () =>
        Effect.sync(
          () =>
            ({
              graph,
              graphId: "graph-id",
              state: {
                runId: graph.runId,
                nodes: graph.nodes.map((node) => ({
                  nodeId: node.id,
                  status: DagNodeStatus.Cancelled,
                  reason: "cancelled",
                })),
              },
              terminalOutcome: DagRunOutcome.Cancelled,
              transitions: [],
              attempts: [],
              persistedEntryCount: 1,
              recoveredFromProcessLoss: false,
            }) as unknown as DagSessionReconstruction,
        ),
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      runReviewDag({
        pi: piEvents(),
        ctx: f.ctx,
        signal: controller.signal,
        service: service as any,
        assignments,
        deckPath: f.deckPath,
        state: f.state,
        save: (state) => saved.push(structuredClone(state)),
      }),
    ).rejects.toThrow();
    expect(cancelled).toBe(true);
    expect(saved.at(-1)?.dag?.status).toBe("cancelled");
  });
});
