import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Data, Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionResultTag,
  DagTransitionType,
  createDagRunState,
  reduceDagRunState,
  type DagRunState,
  type DagSessionReconstruction,
  type DagTextArtifactReference,
  type DagTransition,
  type ValidatedDagDefinition,
} from "../../../../src/dag/index.js";
import { runReviewDag } from "../review-dag-runner";
import {
  runRealReviewFlow,
  reviewFixture as fixture,
  assignments,
  availableModels,
  eventsApi as piEvents,
  type ModelDossier,
} from "./fixtures/review-flow";
import { EvidenceResolverNode, ReviewerNodes } from "../review-graph";
import { ReviewEvidenceChunkOutputs } from "../evidence-resolver";
import type { ReviewState } from "../schema";
import { readVerifiedRawFinding } from "../reviewer-dossier";

class TestAppendFailure extends Data.TaggedError("TestAppendFailure")<{
  readonly message: string;
}> {}

function inventedSynthesis(dossier: ModelDossier): string {
  return JSON.stringify({
    v: 2,
    verdict: "Invented provenance",
    coverage: { status: "complete", succeeded: [], failed: [], malformed: [] },
    findings: [
      { ...dossier.succeeded[0].rawFindings[0].finding, rawFindingIds: [`R-${"f".repeat(64)}`] },
    ],
    dismissals: [],
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
  it("honors a supported role pin through the real offline session runtime", async () => {
    const model = availableModels
      .map((candidate) => `${candidate.provider}/${candidate.id}`)
      .find((id) => id !== assignments.correctness.model);
    if (!model) throw new Error("Role-pin fixture needs an alternative registry model");
    const flow = await runRealReviewFlow(undefined, { pins: { correctness: model } });
    const node = ReviewerNodes.find((candidate) => candidate.role === "correctness");
    expect(flow.requests.find((request) => request.nodeId === node?.nodeId)?.model).toBe(model);
    expect(flow.state.dag?.status).toBe("succeeded");
    expect(flow.state.result?.coverage?.status).toBe("complete");
  });

  it.each([
    { name: "empty roster", options: { models: [] }, code: "no_available_models" },
    {
      name: "unknown role pin",
      options: { pins: { invented: "provider-a/model" } },
      code: "invalid_pin",
    },
    {
      name: "unavailable model pin",
      options: { pins: { security: "missing/model" } },
      code: "invalid_pin",
    },
  ])("rejects $name before running a review", async ({ options, code }) => {
    await expect(runRealReviewFlow(undefined, options)).rejects.toMatchObject({ code });
  });

  it("produces a finalized review through the real offline session runtime", async () => {
    const flow = await runRealReviewFlow();
    const registryModels = availableModels.map((model) => `${model.provider}/${model.id}`);
    expect(flow.requests.length).toBeGreaterThan(0);
    for (const request of flow.requests) expect(registryModels).toContain(request.model);
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
    expect(flow.registeredTools).toBe(0);
    expect(flow.unregisteredTools).toBe(0);
    expect(flow.serviceDisposals).toBe(1);
  });

  it("does not publish private tools when the first state save fails", async () => {
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
        service: {
          submit: () => Effect.die("submission must not run"),
          reconstruct: () => Effect.die("reconstruction must not run"),
        } as any,
        assignments,
        deckPath: f.deckPath,
        state: f.state,
        save: () => {
          throw new Error("state append failed");
        },
      }),
    ).rejects.toThrow("state append failed");
    expect(registered).toBe(0);
    expect(unregistered).toBe(registered);
  });

  it("preserves valid findings and reports failed and malformed reviewer paths as degraded", async () => {
    const flow = await runRealReviewFlow(undefined, {
      reviewerOutput: (role, text) => {
        if (role === "security") throw new Error("Reviewer unavailable");
        if (role === "maintainability") {
          return JSON.stringify({ ...JSON.parse(text), role: "security" });
        }
        return text;
      },
    });
    const { state: result, saved, dossier } = flow;
    expect(flow.workspaceRoot).toBe(result.snapshot.worktree);
    expect(dossier!.failed).toContain("review-security");
    expect(dossier!.malformed).toContain("review-maintainability");
    expect(dossier!.succeeded.map((item) => item.role)).toEqual([
      "correctness",
      "intent",
      "tests",
      "whole-change",
    ]);
    const deck = await flow.readDeck();
    expect(JSON.parse(deck.content[0].text).snapshotId).toBe("review");
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(flow.readDeck(cancelled.signal)).rejects.toThrow("cancelled");
    expect(flow.progress).not.toHaveLength(0);
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
      sourceReviewers: ["correctness", "intent"],
      agreement: 2,
    });
    expect(result.result?.provenance).toMatchObject({ v: 2, status: "accepted" });
    expect(saved.at(-1)).toEqual(result);
    const rawRecord = result.result?.provenance?.rawFindings[0];
    expect(rawRecord).not.toHaveProperty("finding");
    expect(
      (await readVerifiedRawFinding(flow.artifactRoot, result.dag!.runId, rawRecord!)).finding
        .problem,
    ).toBe("The exported value violates the requested contract.");
    expect(
      saved.at(-1)?.dag?.rawResultReferences.every((reference) => !reference.path.includes("{")),
    ).toBe(true);
  });

  it("fails closed when a published reviewer artifact changes before collection", async () => {
    const flow = await runRealReviewFlow(undefined, {
      beforeCollection: (artifactRoot, reconstruction) => {
        const node = reconstruction.state.nodes.find(
          (candidate) => candidate.nodeId === "review-correctness",
        );
        if (node?.status !== DagNodeStatus.Succeeded) throw new Error("Reviewer did not finish");
        const reference = Object.values(node.outputs)[0] as DagTextArtifactReference;
        writeFileSync(path.join(artifactRoot, reference.path), "tampered");
      },
    });
    expect(flow.state.dag?.status).toBe("degraded");
    expect(flow.state.dag?.malformedNodes).toContain("review-correctness");
    expect(flow.state.result?.coverage?.succeeded).not.toContain("correctness");
    expect(flow.saved.at(-1)).toEqual(flow.state);
  });

  it("reports a failed synthesis node while preserving reviewer findings", async () => {
    const flow = await runRealReviewFlow(undefined, {
      synthesisOutput: () => {
        throw new Error("Synthesis unavailable");
      },
    });
    const result = flow.state;
    expect(flow.saved.at(-1)).toEqual(result);
    expect(result.dag).toMatchObject({
      status: "degraded",
      failedNodes: ["synthesis"],
    });
    expect(result.result?.findings).toHaveLength(6);
    expect(result.result?.findings[0]?.problem).toBe(
      "The exported value violates the requested contract.",
    );
    expect(result.result?.provenance?.status).toBe("fallback");
  });

  it("rejects synthesis provenance that is not present in the admitted raw findings", async () => {
    const flow = await runRealReviewFlow(undefined, { synthesisOutput: inventedSynthesis });
    const result = flow.state;
    expect(flow.saved.at(-1)).toEqual(result);
    expect(result.dag?.status).toBe("degraded");
    expect(result.result?.verdict).toContain("Reviewer consolidation failed");
    expect(result.result?.findings[0]?.problem).toBe(
      "The exported value violates the requested contract.",
    );
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
    const flow = await runRealReviewFlow(undefined, {
      reviewerOutput: (role, text) => {
        if (role !== "intent") return text;
        const output = JSON.parse(text);
        delete output.findings[0].line;
        return JSON.stringify(output);
      },
    });
    expect(flow.state.dag?.malformedNodes).toContain("review-intent");
    expect(flow.state.result?.coverage?.succeeded).not.toContain("intent");
    expect(flow.dossier?.malformed).toContain("review-intent");
    expect(flow.dossier?.succeeded.map((item) => item.role)).not.toContain("intent");
    expect(flow.saved.at(-1)).toEqual(flow.state);
  });

  it("rejects a reviewer that does not return the admitted evidence digest", async () => {
    const flow = await runRealReviewFlow(undefined, {
      reviewerOutput: (role, text) =>
        role === "intent"
          ? JSON.stringify({ ...JSON.parse(text), evidenceDigest: "0".repeat(64) })
          : text,
    });
    expect(flow.state.dag?.status).toBe("degraded");
    expect(flow.state.dag?.malformedNodes).toContain("review-intent");
    expect(flow.state.result?.coverage?.succeeded).not.toContain("intent");
    expect(flow.dossier?.malformed).toContain("review-intent");
    expect(flow.dossier?.succeeded.map((item) => item.role)).not.toContain("intent");
    expect(flow.saved.at(-1)).toEqual(flow.state);
  });

  it("preserves identical fallback occurrences instead of field-deduplicating them", async () => {
    const flow = await runRealReviewFlow(undefined, {
      reviewerOutput: (role, text) => {
        const output = JSON.parse(text);
        if (role !== "correctness" && role !== "intent") output.findings = [];
        if (role === "intent") {
          output.findings[0] = Object.fromEntries(Object.entries(output.findings[0]).reverse());
        }
        return JSON.stringify(output);
      },
      synthesisOutput: inventedSynthesis,
    });
    const findings = flow.state.result!.findings;
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.sourceReviewers)).toEqual([
      ["correctness"],
      ["intent"],
    ]);
    expect(findings[0].problem).toBe(findings[1].problem);
    expect(new Set(findings.flatMap((finding) => finding.rawFindingIds ?? [])).size).toBe(2);
    expect(flow.saved.at(-1)).toEqual(flow.state);
  });

  it("fails when every reviewer output is malformed but preserves every raw reference", async () => {
    const saved: ReviewState[] = [];
    let modelDossier: ModelDossier | undefined;
    await expect(
      runRealReviewFlow(undefined, {
        reviewerOutput: () => "not-json",
        synthesisOutput: (dossier) => {
          modelDossier = dossier;
          return "not-json";
        },
        onSave: (state) => saved.push(state),
      }),
    ).rejects.toThrow(/All PR reviewers failed or returned malformed output/);
    expect(saved.at(-1)?.dag).toMatchObject({ status: "failed" });
    expect(saved.at(-1)?.dag?.rawResultReferences).toHaveLength(6);
    expect(saved.at(-1)?.dag?.malformedNodes).toHaveLength(6);
    expect(saved.at(-1)?.plan?.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(saved.at(-1)?.metrics).toMatchObject({
      reviewersFailed: 0,
      reviewersMalformed: 6,
      reviewersBlocked: 0,
    });
    expect(modelDossier?.succeeded).toEqual([]);
    expect(modelDossier?.malformed).toHaveLength(6);
    expect(modelDossier?.verifiedReferences).toHaveLength(6);
  });

  it("rebuilds terminal plan, findings, selection, and metrics from artifact references", async () => {
    const flow = await runRealReviewFlow();
    const rebuilt = await flow.rebuild({ ...flow.submissionState!, decisions: undefined });
    expect(rebuilt.plan?.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(rebuilt.result?.findings[0]).toMatchObject({ id: "F1", anchorValid: true });
    expect(rebuilt.result?.provenance).toMatchObject({ v: 2, status: "accepted" });
    expect(rebuilt.result).toEqual(flow.state.result);
    expect(rebuilt.result?.provenance?.rawFindings).toHaveLength(6);
    expect(rebuilt.selectedFindingIds).toEqual(["F1", "F2", "F3"]);
    expect(rebuilt.metrics).toMatchObject({ reviewersSucceeded: 6, findings: 3 });
  });

  it("retains dismissed raw content and its reason during terminal reconstruction", async () => {
    const flow = await runRealReviewFlow(undefined, {
      synthesisOutput: (dossier) =>
        JSON.stringify({
          v: 2,
          verdict: "All raw concerns were dismissed editorially.",
          coverage: { status: "complete", succeeded: [], failed: [], malformed: [] },
          findings: [],
          dismissals: dossier.succeeded.flatMap((item) =>
            item.rawFindings.map((raw) => ({
              rawFindingId: raw.id,
              reason: "Not actionable for this change.",
            })),
          ),
        }),
    });
    const rebuilt = await flow.rebuild(flow.submissionState);
    expect(rebuilt.result?.findings).toEqual([]);
    expect(rebuilt.result?.provenance?.dismissals[0].reason).toBe(
      "Not actionable for this change.",
    );
    const rawRecord = rebuilt.result?.provenance?.rawFindings[0];
    expect(rawRecord).not.toHaveProperty("finding");
    expect(
      (await readVerifiedRawFinding(flow.artifactRoot, rebuilt.dag!.runId, rawRecord!)).finding
        .problem,
    ).toBe("The exported value violates the requested contract.");
    expect(rebuilt.result).toEqual(flow.saved.at(-1)?.result);
  });

  it("binds restart synthesis decoding to the protocol persisted before submission", async () => {
    const flow = await runRealReviewFlow(undefined, {
      reviewerOutput: (role, text) =>
        role === "correctness" ? text : JSON.stringify({ ...JSON.parse(text), findings: [] }),
      synthesisOutput: (dossier) =>
        JSON.stringify({
          verdict: "Historical exact-text summary.",
          coverage: { status: "complete", succeeded: ["correctness"], failed: [], malformed: [] },
          findings: [
            {
              ...dossier.succeeded.find((item) => item.role === "correctness")!.rawFindings[0]
                .finding,
              sourceReviewers: ["correctness"],
              agreement: 1,
            },
          ],
        }),
    });
    expect(flow.saved[0].dag).toMatchObject({ submitted: false, synthesisProtocol: 2 });
    expect(flow.submissionState?.dag?.synthesisProtocol).toBe(2);
    expect(flow.state.result?.provenance?.status).toBe("fallback");
    const reconstruct = (synthesisProtocol: 2 | undefined | number) =>
      flow.rebuild({
        ...flow.submissionState!,
        dag: {
          runId: flow.state.dag!.runId,
          status: "running",
          rawResultReferences: [],
          ...(synthesisProtocol === undefined ? {} : { synthesisProtocol }),
        },
      } as ReviewState);

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
