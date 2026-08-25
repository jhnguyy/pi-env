import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Data, Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DagExecutorKind,
  DagNodeStatus,
  DagRunOutcome,
  materializeDagTextArtifact,
  publishDagSubagentTextResult,
  type DagEffectExecutor,
  type DagSessionReconstruction,
  type ValidatedDagDefinition,
} from "../../../../src/dag/index.js";
import { reconstructReviewDagState, runReviewDag } from "../review-dag-runner";
import { DagSessionRuntime } from "../../subagent/dag-session-runtime";
import {
  lookupRegisteredDagExecutor,
  registerDagExecutor,
  unregisterDagExecutor,
} from "../../_shared/dag-executor-registration";
import {
  listenForDagRuntimeService,
  resetDagRuntimeServiceRegistryForTests,
} from "../../_shared/dag-runtime-service";
import {
  EvidenceResolverNode,
  ReviewRoles,
  compileReviewGraph,
  type ReviewRoleAssignments,
} from "../review-graph";
import {
  makeReviewEvidenceResolverExecutor,
  ReviewEvidenceChunkOutputs,
  ReviewEvidenceExecutorKind,
  ReviewEvidenceResolverKey,
  ReviewEvidenceCoverageOutput,
} from "../evidence-resolver";
import { buildReviewDeck, updateReviewDeckLaterRefs } from "../deck";
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
  const entries: unknown[] = [];
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
        getBranch: () => entries,
        appendCustomEntry: (customType: string, data: unknown) => {
          entries.push({ type: "custom", customType, data });
          return String(entries.length);
        },
      },
    },
  };
}

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

function plan(): string {
  return JSON.stringify({
    goal: "Change the exported value.",
    goalAssessment: "The diff changes the value.",
    risk: "low",
    riskReasons: [],
    cohorts: [{ label: "code", purpose: "implementation", paths: ["a.ts"] }],
    files: [{ path: "a.ts", attention: "normal", role: "implementation" }],
    evidence: [{ kind: "file", path: "a.ts", startLine: 1, endLine: 1, purpose: "implementation" }],
  });
}
const EvidenceDigest = "d".repeat(64);
function reviewer(role: string): string {
  return JSON.stringify({
    role,
    evidenceDigest: EvidenceDigest,
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
    if (node.id === EvidenceResolverNode.nodeId) {
      const coverage = JSON.stringify({
        v: 1,
        snapshotId: "review",
        headOid: "head",
        diffHash: "a".repeat(64),
        digest: EvidenceDigest,
        uniqueBytes: 10,
        dossierBytes: 20,
        chunks: 1,
        chunkOutputs: [ReviewEvidenceChunkOutputs[0]],
        omissions: [],
        references: 1,
      });
      const outputs: Record<string, unknown> = {};
      for (const [outputName, text] of [
        [ReviewEvidenceCoverageOutput, coverage],
        ...ReviewEvidenceChunkOutputs.map((name, index) => [name, index === 0 ? "evidence" : ""]),
      ] as const) {
        Object.assign(
          outputs,
          await Effect.runPromise(
            publishDagSubagentTextResult(
              artifactRoot,
              graph.runId,
              node.id,
              `attempt-${node.id}`,
              outputName,
              text,
            ),
          ),
        );
      }
      nodes.push({ nodeId: node.id, status: DagNodeStatus.Succeeded, outputs });
      continue;
    }
    const outputName = (node.executor.payload as { output: { name: string } }).output.name;
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
  const tools = new Map<string, any>();
  return {
    tools,
    events: {
      emit(event: string, data: any) {
        if (event === "agent-tools:register") tools.set(data.tool.name, data.tool);
        if (event === "agent-tools:unregister") tools.delete(data.tool.name);
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

describe("DAG-backed pull request review runner", () => {
  it("orchestrates the real session runtime, scheduler, evidence, tools, and fallback offline", async () => {
    const f = fixture();
    resetDagRuntimeServiceRegistryForTests();
    execFileSync("git", ["init", "-q"], { cwd: f.state.snapshot.worktree });
    execFileSync("git", ["config", "user.email", "review@example.test"], {
      cwd: f.state.snapshot.worktree,
    });
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: f.state.snapshot.worktree });
    execFileSync("git", ["add", "a.ts"], { cwd: f.state.snapshot.worktree });
    execFileSync("git", ["commit", "-qm", "snapshot"], { cwd: f.state.snapshot.worktree });
    const headOid = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: f.state.snapshot.worktree,
      encoding: "utf8",
    }).trim();
    const diff =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n";
    writeFileSync(f.state.snapshot.diffPath, diff);
    f.state.snapshot.metadata.headOid = headOid;
    f.state.snapshot.diffHash = createHash("sha256").update(diff).digest("hex");
    const deck = buildReviewDeck({ snapshot: f.state.snapshot });
    const pi = piEvents();
    const services: any[] = [];
    let serviceDisposals = 0;
    listenForDagRuntimeService(
      pi,
      (service) => services.push(service),
      () => serviceDisposals++,
    );
    let registered = 0;
    let unregistered = 0;
    pi.events.on("agent-tools:register", () => registered++);
    pi.events.on("agent-tools:unregister", () => unregistered++);
    const generation = "review-scenario";
    const evidenceRegistration = registerDagExecutor({
      parentSessionId: "parent",
      sessionGeneration: generation,
      kind: ReviewEvidenceExecutorKind,
      key: ReviewEvidenceResolverKey,
      executor: makeReviewEvidenceResolverExecutor({ artifactRoot: f.artifactRoot }),
    });
    const findTool = (prefix: string) => {
      const tool = [...pi.tools.values()].find((candidate) => candidate.name.startsWith(prefix));
      if (!tool) throw new Error(`Missing run-scoped tool ${prefix}`);
      return tool;
    };
    const scriptedSubagent: DagEffectExecutor = (request) =>
      Effect.promise(async () => {
        const output = (request.node.executor.payload as any).output;
        if (request.node.id === "reading-plan") {
          const submitted = await findTool("submit_review_plan_").execute(
            "plan",
            {
              ...JSON.parse(plan()),
              evidence: [
                { kind: "diff", path: "a.ts", startLine: 1, endLine: 6, purpose: "patch" },
              ],
            },
            undefined,
            undefined,
          );
          expect(submitted.isError).not.toBe(true);
          return Effect.runPromise(
            publishDagSubagentTextResult(
              f.artifactRoot,
              request.runId,
              request.node.id,
              request.attemptId,
              output.name,
              submitted.content[0].text,
            ),
          );
        }
        if (request.node.id.startsWith("review-")) {
          const coverage = await Effect.runPromise(
            materializeDagTextArtifact(
              f.artifactRoot,
              (
                request.graphState.nodes.find(
                  (node) =>
                    node.nodeId === EvidenceResolverNode.nodeId &&
                    node.status === DagNodeStatus.Succeeded,
                ) as any
              ).outputs[ReviewEvidenceCoverageOutput],
              {
                runId: request.runId,
                producerNodeId: EvidenceResolverNode.nodeId,
                outputName: ReviewEvidenceCoverageOutput,
              },
            ),
          );
          const role = request.node.id.slice("review-".length);
          const value = JSON.parse(reviewer(role));
          value.evidenceDigest =
            role === "intent" ? "0".repeat(64) : JSON.parse(coverage.text).digest;
          return Effect.runPromise(
            publishDagSubagentTextResult(
              f.artifactRoot,
              request.runId,
              request.node.id,
              request.attemptId,
              output.name,
              JSON.stringify(value),
            ),
          );
        }
        if (request.node.id === "synthesis") {
          const refs = await findTool("review_result_refs_").execute(
            "refs",
            {},
            undefined,
            undefined,
          );
          expect(refs.isError).not.toBe(true);
          const rejected = JSON.parse(synthesis());
          rejected.findings[0].problem = "Not present in an admitted reviewer result.";
          const submitted = await findTool("submit_review_synthesis_").execute(
            "synthesis",
            rejected,
            undefined,
            undefined,
          );
          expect(submitted.isError).toBe(true);
          return Effect.runPromise(
            publishDagSubagentTextResult(
              f.artifactRoot,
              request.runId,
              request.node.id,
              request.attemptId,
              output.name,
              JSON.stringify(rejected),
            ),
          );
        }
        throw new Error(`Unexpected scripted node ${request.node.id}`);
      });
    const registry = {
      lookup: (kind: DagExecutorKind, key: string) =>
        Effect.succeed(
          kind === DagExecutorKind.Subagent && key === "pi/subagent-v1"
            ? scriptedSubagent
            : lookupRegisteredDagExecutor("parent", generation, kind, key),
        ),
    };
    const runtime = await DagSessionRuntime.create(pi, f.ctx, new Map(), {
      sessionGeneration: generation,
      supervisor: {
        usage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }),
      } as any,
      telemetryRuntime: {} as any,
      ledger: {} as any,
      executorRegistry: registry,
    });
    expect(services).toHaveLength(1);
    const saved: ReviewState[] = [];
    try {
      const result = await runReviewDag({
        pi,
        ctx: f.ctx,
        service: services[0].service,
        assignments,
        deckPath: deck.path,
        state: f.state,
        save: (state) => saved.push(structuredClone(state)),
      });
      expect(result.dag).toMatchObject({
        status: "degraded",
        malformedNodes: ["review-intent", "synthesis"],
      });
      expect(result.dag?.evidenceCoverage?.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.result?.verdict).toContain("Reviewer synthesis failed");
      expect(result.result?.coverage?.succeeded).not.toContain("intent");
      expect(saved.some((state) => state.dag?.submitted)).toBe(true);
      expect(saved.at(-1)?.dag?.status).toBe("degraded");
      expect(unregistered).toBe(registered);
      const updated = updateReviewDeckLaterRefs({
        snapshot: f.state.snapshot,
        readingPlanRefs: [
          { kind: "reading-plan", id: "plan", uri: result.dag!.readingPlanReference!.path },
        ],
        rawResultRefs: result.dag!.rawResultReferences.map((reference, index) => ({
          kind: "raw-result",
          id: `result-${index}`,
          uri: reference.path,
        })),
      });
      expect(updated.deck.laterRefs.readingPlanRefs).toHaveLength(1);
      expect(updated.deck.laterRefs.rawResultRefs).toHaveLength(6);
    } finally {
      await runtime.dispose();
      unregisterDagExecutor(evidenceRegistration);
      resetDagRuntimeServiceRegistryForTests();
    }
    expect(serviceDisposals).toBe(1);
  });

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
    expect(authority).toEqual({ workspaceRoot: f.state.snapshot.worktree });
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

  it("fails closed when a published reviewer artifact changes before collection", async () => {
    const f = fixture();
    const service = serviceFor(f.artifactRoot, {});
    const reconstruct = service.reconstruct;
    service.reconstruct = () =>
      reconstruct().pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            const reconstruction = value as DagSessionReconstruction;
            const node = reconstruction.state.nodes.find(
              (candidate) =>
                candidate.nodeId === "review-correctness" &&
                candidate.status === DagNodeStatus.Succeeded,
            );
            const reference = Object.values(
              node?.status === DagNodeStatus.Succeeded ? node.outputs : {},
            )[0] as any;
            writeFileSync(path.join(f.artifactRoot, reference.path), "tampered");
          }),
        ),
      );
    const result = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service,
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: () => {},
    });
    expect(result.dag?.status).toBe("degraded");
    expect(result.dag?.malformedNodes).toEqual(expect.arrayContaining(["review-correctness"]));
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

  it("rejects a reviewer with an incoherent partial anchor", async () => {
    const f = fixture();
    const partialAnchor = JSON.parse(reviewer("intent"));
    partialAnchor.findings = [
      {
        severity: "serious",
        impact: "high",
        file: "a.ts",
        side: "RIGHT",
        problem: "The anchor is incomplete.",
        consequence: "The finding cannot be located.",
        suggestedFix: "Include a line or omit the side.",
      },
    ];
    const result = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service: serviceFor(f.artifactRoot, {
        "review-intent": JSON.stringify(partialAnchor),
      }),
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: () => {},
    });
    expect(result.dag?.malformedNodes).toContain("review-intent");
  });

  it("rejects a reviewer that does not return the admitted evidence digest", async () => {
    const f = fixture();
    const wrongDigest = JSON.parse(reviewer("intent"));
    wrongDigest.evidenceDigest = "0".repeat(64);
    const result = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service: serviceFor(f.artifactRoot, {
        "review-intent": JSON.stringify(wrongDigest),
      }),
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: () => {},
    });
    expect(result.dag?.status).toBe("degraded");
    expect(result.dag?.malformedNodes).toContain("review-intent");
    expect(result.result?.coverage?.succeeded).not.toContain("intent");
  });

  it("deduplicates fallback findings by fields instead of JSON property order", async () => {
    const f = fixture();
    const reordered = JSON.stringify({
      role: "intent",
      evidenceDigest: EvidenceDigest,
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
            resultReferences: "review_refs_test",
            synthesisSubmission: "submit_synthesis_test",
          },
          evidence: {
            v: 1,
            snapshotId: "review",
            headOid: "head",
            diffHash: "a".repeat(64),
            worktree: f.state.snapshot.worktree,
            diffPath: f.state.snapshot.diffPath,
            changedPaths: ["a.ts"],
            planOutputName: "reading_plan",
            reviewerContextWindow: 272_000,
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
