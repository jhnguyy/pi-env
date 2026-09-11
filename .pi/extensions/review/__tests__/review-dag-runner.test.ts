import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Data, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionResultTag,
  DagTransitionType,
  createDagRunState,
  publishDagSubagentTextResult,
  reduceDagRunState,
  type DagNodeResult,
  type DagRunState,
  type DagSessionReconstruction,
  type DagTextArtifactReference,
  type DagTransition,
  type ValidatedDagDefinition,
} from "../../../../src/dag/index.js";
import { reconstructReviewDagState, runReviewDag } from "../review-dag-runner";
import {
  runRealReviewFlow,
  reviewFixture as fixture,
  assignments,
  eventsApi as piEvents,
} from "./fixtures/review-flow";
import { EvidenceResolverNode, compileReviewGraph } from "../review-graph";
import { ReviewEvidenceChunkOutputs, ReviewEvidenceCoverageOutput } from "../evidence-resolver";
import type { ReviewState } from "../schema";
import { buildRawFindingRecords } from "../synthesis-provenance";
import { readVerifiedRawFinding } from "../reviewer-dossier";

class TestAppendFailure extends Data.TaggedError("TestAppendFailure")<{
  readonly message: string;
}> {}

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
function legacySynthesis(): string {
  const correctness = JSON.parse(reviewer("correctness"));
  return JSON.stringify({
    verdict: "Historical exact-text summary.",
    coverage: { status: "complete", succeeded: ["correctness"], failed: [], malformed: [] },
    findings: [
      {
        ...correctness.findings[0],
        sourceReviewers: ["correctness"],
        agreement: 1,
      },
    ],
  });
}
function expectedRawFindingId(): string {
  const correctness = JSON.parse(reviewer("correctness"));
  return buildRawFindingRecords([
    {
      reviewer: correctness,
      reference: {
        v: 1,
        path: "unused",
        bytes: 1,
        digest: "0".repeat(64),
        runId: "unused",
        producerNodeId: "review-correctness",
        outputName: "correctness_review",
      },
    },
  ])[0].id;
}
function synthesis(): string {
  const rawFindingId = expectedRawFindingId();
  return JSON.stringify({
    v: 2,
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
        rawFindingIds: [rawFindingId],
      },
    ],
    dismissals: [],
  });
}

function dismissedSynthesis(): string {
  const rawFindingId = expectedRawFindingId();
  return JSON.stringify({
    v: 2,
    verdict: "The raw concern was dismissed editorially.",
    coverage: { status: "complete", succeeded: [], failed: [], malformed: [] },
    findings: [],
    dismissals: [{ rawFindingId, reason: "Not actionable for this change." }],
  });
}

function applyTransition(
  graph: ValidatedDagDefinition<unknown>,
  state: DagRunState<unknown, { readonly message: string }>,
  transition: DagTransition<unknown, { readonly message: string }>,
): DagRunState<unknown, { readonly message: string }> {
  const reduced = reduceDagRunState(graph, state, transition);
  if (reduced._tag !== DagTransitionResultTag.Applied)
    throw new Error(`Invalid test DAG transition: ${JSON.stringify(reduced.error)}`);
  return reduced.state;
}

function completeNode(
  graph: ValidatedDagDefinition<unknown>,
  state: DagRunState<unknown, { readonly message: string }>,
  nodeId: string,
  result: DagNodeResult<unknown, { readonly message: string }>,
): DagRunState<unknown, { readonly message: string }> {
  const running = applyTransition(graph, state, {
    runId: graph.runId,
    type: DagTransitionType.Start,
    nodeId,
  });
  return applyTransition(graph, running, {
    runId: graph.runId,
    type: DagTransitionType.Complete,
    nodeId,
    result,
  });
}

async function reconstructionFor(
  artifactRoot: string,
  graph: ValidatedDagDefinition<unknown>,
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
  let state = createDagRunState<unknown, unknown, { readonly message: string }>(graph);
  for (const node of graph.nodes) {
    const value = overrides[node.id] ?? defaults[node.id];
    if (value === "failed") {
      state = completeNode(graph, state, node.id, {
        _tag: DagNodeResultTag.Failed,
        failure: { message: "failed" },
      });
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
      state = completeNode(graph, state, node.id, {
        _tag: DagNodeResultTag.Succeeded,
        outputs,
      });
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
    state = completeNode(graph, state, node.id, {
      _tag: DagNodeResultTag.Succeeded,
      outputs,
    });
  }
  return {
    graph,
    graphId: "graph-id",
    state,
    terminalOutcome: Object.values(overrides).includes("failed")
      ? DagRunOutcome.Failed
      : DagRunOutcome.Succeeded,
    transitions: [],
    attempts: [],
    persistedEntryCount: 1,
    recoveredFromProcessLoss: false,
  } satisfies DagSessionReconstruction;
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

describe("DAG-backed pull request review runner", () => {
  it.each(["missing", "tampered"])(
    "does not admit findings from a %s evidence bundle",
    async (fault) => {
      await expect(
        runRealReviewFlow(async ({ artifactRoot, request }) => {
          const node = request.graphState.nodes.find(
            (candidate) => candidate.nodeId === EvidenceResolverNode.nodeId,
          );
          if (node?.status !== DagNodeStatus.Succeeded)
            throw new Error("Evidence was not produced.");
          const chunk = node.outputs[ReviewEvidenceChunkOutputs[0]] as DagTextArtifactReference;
          const file = path.join(artifactRoot, chunk.path);
          if (fault === "missing") rmSync(file);
          else writeFileSync(file, "tampered evidence");
        }),
      ).rejects.toThrow(/All PR reviewers failed or returned malformed output/);
    },
  );

  it("can inspect and consolidate after cancelling an earlier dossier read", async () => {
    const flow = await runRealReviewFlow(async ({ inspect }) => {
      const controller = new AbortController();
      const cancelled = inspect(controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toBeDefined();
    });
    expect(flow.state.result?.provenance?.status).toBe("accepted");
  });
  it("produces a finalized review through the real offline session runtime", async () => {
    const flow = await runRealReviewFlow();
    expect(flow.state.dag).toMatchObject({ status: "succeeded" });
    expect(flow.state.result?.coverage?.succeeded).toEqual(
      expect.arrayContaining([
        "correctness",
        "intent",
        "maintainability",
        "tests",
        "security",
        "whole-change",
      ]),
    );
    expect(flow.state.result?.findings.map((finding) => finding.sourceReviewers)).toEqual([
      ["correctness", "intent"],
      ["maintainability", "tests"],
      ["security"],
    ]);
    expect(flow.state.result?.provenance?.dismissals[0]?.reason).toContain("outside");
    expect(flow.invalidSynthesisRejected).toBe(true);
    const accountedRawIds = [
      ...flow.state.result!.findings.flatMap((finding) => finding.rawFindingIds ?? []),
      ...flow.state.result!.provenance!.dismissals.map((dismissal) => dismissal.rawFindingId),
    ];
    expect(accountedRawIds.sort()).toEqual([...flow.dossierRawIds].sort());
    expect(flow.saved.some((state) => state.dag?.submitted)).toBe(true);
    expect(flow.saved.at(-1)).toEqual(flow.state);
    expect(flow.unregisteredTools).toBe(flow.registeredTools);
    expect(flow.serviceDisposals).toBe(1);
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
    expect(result.result?.provenance).toMatchObject({
      v: 2,
      status: "accepted",
      dismissals: [],
    });
    const rawRecord = result.result?.provenance?.rawFindings[0];
    expect(rawRecord).not.toHaveProperty("finding");
    expect(
      (await readVerifiedRawFinding(f.artifactRoot, result.dag!.runId, rawRecord!)).finding.problem,
    ).toBe("The value is wrong.");
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

  it("rejects synthesis provenance that is not present in the admitted raw findings", async () => {
    const f = fixture();
    const invented = JSON.parse(synthesis());
    invented.findings[0].rawFindingIds = [`R-${"f".repeat(64)}`];
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
    expect(result.result?.verdict).toContain("Reviewer consolidation failed");
    expect(result.result?.findings[0]?.problem).toBe("The value is wrong.");
    expect(result.result?.findings[0]).toMatchObject({
      sourceReviewers: ["correctness"],
      agreement: 1,
    });
    expect(result.result?.provenance).toMatchObject({
      status: "fallback",
      fallbackReason: expect.stringContaining("exactly once"),
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

  it("preserves identical fallback occurrences instead of field-deduplicating them", async () => {
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
    invented.findings[0].rawFindingIds = [`R-${"f".repeat(64)}`];
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
    expect(result.result?.findings).toHaveLength(2);
    expect(result.result?.findings.map((finding) => finding.sourceReviewers)).toEqual([
      ["correctness"],
      ["intent"],
    ]);
    expect(
      new Set(result.result?.findings.flatMap((finding) => finding.rawFindingIds ?? [])).size,
    ).toBe(2);
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
    expect(rebuilt.result?.provenance).toMatchObject({ v: 2, status: "accepted" });
    expect(rebuilt.result?.provenance?.rawFindings).toHaveLength(1);
    expect(rebuilt.selectedFindingIds).toEqual(["F1"]);
    expect(rebuilt.metrics).toMatchObject({ reviewersSucceeded: 6, findings: 1 });
  });

  it("retains dismissed raw content and its reason during terminal reconstruction", async () => {
    const f = fixture();
    const service = serviceFor(f.artifactRoot, { synthesis: dismissedSynthesis() });
    await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service,
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: () => {},
    });
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
          status: "running",
          rawResultReferences: [],
        },
      },
      reconstruction,
    });
    expect(rebuilt.result?.findings).toEqual([]);
    expect(rebuilt.result?.provenance?.dismissals[0].reason).toBe(
      "Not actionable for this change.",
    );
    const rawRecord = rebuilt.result?.provenance?.rawFindings[0];
    expect(rawRecord).not.toHaveProperty("finding");
    expect(
      (await readVerifiedRawFinding(f.artifactRoot, reconstruction.graph.runId, rawRecord!)).finding
        .problem,
    ).toBe("The value is wrong.");
  });

  it("binds restart synthesis decoding to the protocol persisted before submission", async () => {
    const f = fixture();
    const saved: ReviewState[] = [];
    let protocolWasPersistedAtSubmission = false;
    const service = serviceFor(f.artifactRoot, { synthesis: legacySynthesis() }, () => {
      protocolWasPersistedAtSubmission = saved.at(-1)?.dag?.synthesisProtocol === 2;
    });
    const current = await runReviewDag({
      pi: piEvents(),
      ctx: f.ctx,
      service,
      assignments,
      deckPath: f.deckPath,
      state: f.state,
      save: (state) => saved.push(structuredClone(state)),
    });
    expect(saved[0].dag).toMatchObject({ submitted: false, synthesisProtocol: 2 });
    expect(protocolWasPersistedAtSubmission).toBe(true);
    expect(current.result?.provenance?.status).toBe("fallback");

    const reconstruction = (await Effect.runPromise(
      service.reconstruct(),
    )) as DagSessionReconstruction;
    const reconstruct = (synthesisProtocol: 2 | undefined | number) =>
      reconstructReviewDagState({
        ctx: f.ctx,
        service,
        state: {
          ...f.state,
          dag: {
            runId: reconstruction.graph.runId,
            status: "running",
            rawResultReferences: [],
            ...(synthesisProtocol === undefined ? {} : { synthesisProtocol }),
          },
        } as ReviewState,
        reconstruction,
      });

    const marked = await reconstruct(2);
    expect(marked.result?.provenance?.status).toBe("fallback");
    const historical = await reconstruct(undefined);
    expect(historical.result?.verdict).toBe("Historical exact-text summary.");
    expect(historical.result?.provenance).toBeUndefined();
    const unknown = await reconstruct(99);
    expect(unknown.result?.provenance?.status).toBe("fallback");
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
        Effect.sync(() => {
          let state = createDagRunState<unknown, unknown, { readonly message: string }>(graph);
          for (const node of graph.nodes) {
            state = applyTransition(graph, state, {
              runId: graph.runId,
              type: DagTransitionType.Cancel,
              nodeId: node.id,
              reason: "cancelled",
            });
          }
          return {
            graph,
            graphId: "graph-id",
            state,
            terminalOutcome: DagRunOutcome.Cancelled,
            transitions: [],
            attempts: [],
            persistedEntryCount: 1,
            recoveredFromProcessLoss: false,
          } satisfies DagSessionReconstruction;
        }),
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
