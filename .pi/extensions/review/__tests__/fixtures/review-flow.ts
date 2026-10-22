import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { onTestFinished } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  DagExecutorKind,
  DagExecutorFailed,
  DagNodeStatus,
  materializeDagTextArtifact,
  publishDagSubagentTextResult,
  type DagEffectExecutor,
  type DagSessionReconstruction,
} from "../../../../../src/dag/index.js";
import { DagSessionRuntime } from "../../../subagent/dag-session-runtime";
import {
  lookupRegisteredDagExecutor,
  registerDagExecutor,
  unregisterDagExecutor,
} from "../../../_shared/dag-executor-registration";
import {
  listenForDagRuntimeService,
  registerDagRuntimeService,
  unregisterDagRuntimeService,
  type DagRuntimeServiceRegistration,
} from "../../../_shared/dag-runtime-service";
import { REVIEW_ENTRY_TYPE, type ReviewState } from "../../core";
import { buildReviewDeck, type ReviewDeck } from "../../deck";
import {
  reviewEvidenceResolverExecutor,
  ReviewEvidenceCoverageOutput,
  ReviewEvidenceExecutorKind,
  ReviewEvidenceResolverKey,
} from "../../evidence-resolver";
import { EvidenceResolverNode, type ReviewRoleAssignments } from "../../review-graph";
import { resolvePrReviewModelPolicy } from "../../model-policy";
import { reconstructReviewDagState, runReviewDag } from "../../review-dag-runner";
import type { reviewerDossierContext } from "../../reviewer-dossier";

export type ModelDossier = ReturnType<typeof reviewerDossierContext>;

export function reviewFixture(): {
  root: string;
  artifactRoot: string;
  deckPath: string;
  state: ReviewState;
  ctx: any;
} {
  const root = mkdtempSync(path.join(tmpdir(), "pr-review-dag-runner-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "worktree");
  const artifacts = path.join(root, "pr-review", "artifacts", "review");
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
      diffHash: createHash("sha256").update(readFileSync(diffPath)).digest("hex"),
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

export const availableModels = ["provider-a", "provider-b"].map(
  (provider): Model<"openai-responses"> => ({
    provider,
    id: "model",
    name: "model",
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    thinkingLevelMap: { xhigh: null, max: null },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 32_000,
  }),
);

function assignmentsFor(): ReviewRoleAssignments {
  const resolved = resolvePrReviewModelPolicy(availableModels, availableModels);
  return Object.fromEntries(
    Object.entries(resolved.assignments).map(([role, candidate]) => [
      role,
      {
        model: candidate.fqid,
        reasoning: candidate.reasoning,
        contextWindow: candidate.contextWindow,
      },
    ]),
  ) as ReviewRoleAssignments;
}

export const assignments = assignmentsFor();

export function eventsApi(): any {
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

function reviewer(role: string, evidenceDigest: string): string {
  const concern = (problem: string) => ({
    severity: "serious" as const,
    impact: "high" as const,
    file: "a.ts",
    side: "RIGHT" as const,
    line: 1,
    problem,
    consequence: `Callers are exposed to ${problem.toLowerCase()}.`,
    suggestedFix: `Fix ${problem.toLowerCase()}.`,
  });
  const findings =
    role === "correctness" || role === "intent"
      ? [concern("The exported value violates the requested contract.")]
      : role === "maintainability" || role === "tests"
        ? [concern("The change has no durable regression coverage.")]
        : role === "security"
          ? [concern("The input boundary needs explicit validation.")]
          : [concern("The formatting concern is not actionable for this change.")];
  return JSON.stringify({ role, evidenceDigest, verdict: `${role} reviewed`, findings });
}

export interface RealReviewFlow {
  readonly root: string;
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly artifactRoot: string;
  readonly state: ReviewState;
  readonly saved: readonly ReviewState[];
  readonly submissionState?: ReviewState;
  readonly workspaceRoot?: string;
  readonly progress: readonly unknown[];
  readonly rebuild: (state?: ReviewState) => Promise<ReviewState>;
  readonly readDeck: (signal?: AbortSignal) => Promise<any>;
  readonly entries: readonly unknown[];
  readonly invalidSynthesisRejected: boolean;
  readonly dossierRawIds: readonly string[];
  readonly dossier?: ModelDossier;
  readonly registeredTools: number;
  readonly unregisteredTools: number;
  readonly serviceDisposals: number;
}

/**
 * Artifact corruption and terminal replay need controlled publication/collection boundaries.
 * Keep admission, artifact IO, and reconstruction real. The native public workflow owns
 * model selection and provider failures; this fixture retains fault-oriented execution control.
 */
export async function runRealReviewFlow(
  beforeSynthesis?: (boundary: {
    artifactRoot: string;
    request: Parameters<DagEffectExecutor>[0];
    inspect: (signal?: AbortSignal) => Promise<any>;
  }) => Promise<void>,
  options: {
    readonly publicCreate?: {
      readonly root: string;
      readonly pi: any;
      readonly ctx: any;
      readonly execute: () => Promise<ReviewState>;
    };
    readonly reviewerOutput?: (role: string, text: string) => string;
    readonly synthesisOutput?: (dossier: ModelDossier) => string;
    readonly beforeCollection?: (artifactRoot: string, value: DagSessionReconstruction) => void;
    readonly onSave?: (state: ReviewState) => void;
  } = {},
): Promise<RealReviewFlow> {
  await using cleanup = new AsyncDisposableStack();
  const resolvedAssignments = assignmentsFor();
  const fixture = options.publicCreate ?? reviewFixture();
  const { root, ctx } = fixture;
  const initial = "state" in fixture ? fixture.state : undefined;
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactRoot = path.join(sessionDir, "dag-artifacts", sessionId);
  const entries: unknown[] = ctx.sessionManager.getBranch();
  let deckPath: string | undefined;
  if (initial) {
    const { worktree, diffPath } = initial.snapshot;
    initial.decisions = {};
    const later = `// later pinned evidence ${"x".repeat(5_200)} end-of-later-evidence`;
    writeFileSync(
      path.join(worktree, "a.ts"),
      `export const value = 1;\n${"\n".repeat(18)}${later}\n`,
    );
    execFileSync("git", ["init", "-q"], { cwd: worktree });
    execFileSync("git", ["config", "user.email", "review@example.test"], { cwd: worktree });
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: worktree });
    execFileSync("git", ["add", "a.ts"], { cwd: worktree });
    execFileSync("git", ["commit", "-qm", "snapshot"], { cwd: worktree });
    const headOid = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
      encoding: "utf8",
    }).trim();
    const diff =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n" +
      `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -20 +20 @@\n-// old note\n+${later}\n`;
    writeFileSync(diffPath, diff);
    initial.snapshot.metadata.headOid = headOid;
    initial.snapshot.diffHash = createHash("sha256").update(diff).digest("hex");
    deckPath = buildReviewDeck({ snapshot: initial.snapshot }).path;
  }
  const pi = options.publicCreate?.pi ?? eventsApi();
  const services: DagRuntimeServiceRegistration[] = [];
  let serviceDisposals = 0;
  let registeredTools = 0;
  let unregisteredTools = 0;
  const stopRuntimeListener = listenForDagRuntimeService(
    pi,
    (service) => services.push(service),
    () => serviceDisposals++,
  );
  cleanup.defer(stopRuntimeListener);
  pi.events.on("agent-tools:register", () => registeredTools++);
  pi.events.on("agent-tools:unregister", () => unregisteredTools++);
  const generation = "review-scenario";
  if (!options.publicCreate) {
    const evidenceRegistration = registerDagExecutor({
      parentSessionId: sessionId,
      sessionGeneration: generation,
      kind: ReviewEvidenceExecutorKind,
      key: ReviewEvidenceResolverKey,
      executor: reviewEvidenceResolverExecutor({ artifactRoot }),
    });
    cleanup.defer(() => unregisterDagExecutor(evidenceRegistration));
  }
  let customTools: readonly ToolDefinition[] = [];
  const findTool = (prefix: string) => {
    const tool = customTools.find((candidate) => candidate.name.startsWith(prefix));
    if (!tool) throw new Error(`Missing run-scoped tool ${prefix}`);
    return {
      execute: (id: string, params: any, signal?: AbortSignal) =>
        tool.execute(id, params, signal, undefined, ctx),
    };
  };
  let invalidSynthesisRejected = false;
  let dossierRawIds: string[] = [];
  let dossier: ModelDossier | undefined;
  const scriptedText = async (request: Parameters<DagEffectExecutor>[0]) => {
    if (request.node.id === "reading-plan") {
      const deckReply = await findTool("review_deck_").execute("deck", {});
      const deck: ReviewDeck = JSON.parse(
        deckReply.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      );
      const publicEvidence = deck.files.flatMap((file) =>
        (file.diffHunks ?? []).map(([startLine, endLine]) => ({
          kind: "diff" as const,
          path: file.path,
          startLine,
          endLine,
          purpose: "patch",
        })),
      );
      const submitted = await findTool("submit_review_plan_").execute("plan", {
        goal: "Change the exported value.",
        goalAssessment: "The diff changes the value.",
        risk: "low",
        riskReasons: [],
        cohorts: [{ label: "code", purpose: "implementation", paths: ["a.ts"] }],
        files: [{ path: "a.ts", attention: "high", role: "implementation" }],
        evidence: initial
          ? [{ kind: "diff", path: "a.ts", startLine: 1, endLine: 12, purpose: "patch" }]
          : publicEvidence,
      });
      if (submitted.isError) throw new Error("Reading plan was rejected");
      return submitted.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    }
    if (request.node.id.startsWith("review-")) {
      const coverageNode = request.graphState.nodes.find(
        (node) =>
          node.nodeId === EvidenceResolverNode.nodeId && node.status === DagNodeStatus.Succeeded,
      ) as any;
      const coverage = await Effect.runPromise(
        materializeDagTextArtifact(
          artifactRoot,
          coverageNode.outputs[ReviewEvidenceCoverageOutput],
          {
            runId: request.runId,
            producerNodeId: EvidenceResolverNode.nodeId,
            outputName: ReviewEvidenceCoverageOutput,
          },
        ),
      );
      const role = request.node.id.slice("review-".length);
      const text = reviewer(role, JSON.parse(coverage.text).digest);
      return options.reviewerOutput?.(role, text) ?? text;
    }
    if (request.node.id === "synthesis") {
      const inspect = (signal?: AbortSignal) =>
        findTool("review_result_refs_").execute("refs", {}, signal);
      await beforeSynthesis?.({ artifactRoot, request, inspect });
      const refs = await inspect();
      if (refs.isError) throw new Error("Reviewer dossier was unavailable");
      dossier = JSON.parse(
        refs.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ) as ModelDossier;
      dossierRawIds = dossier.succeeded.flatMap((item) => item.rawFindings.map((raw) => raw.id));
      if (options.synthesisOutput) return options.synthesisOutput(dossier);
      const raw = Object.fromEntries(
        dossier.succeeded.map((item: any) => [item.role, item.rawFindings[0]]),
      );
      const invalid = await findTool("submit_review_synthesis_").execute("synthesis", {
        v: 2,
        verdict: "invalid accounting",
        coverage: { status: "complete", succeeded: [], failed: [], malformed: [] },
        findings: [{ ...raw.correctness.finding, rawFindingIds: ["R-invented"] }],
        dismissals: [],
      });
      invalidSynthesisRejected = invalid.isError === true;
      const submitted = await findTool("submit_review_synthesis_").execute("synthesis", {
        v: 2,
        verdict: "Editorial consolidation retained three actionable concerns.",
        coverage: {
          status: "complete",
          succeeded: dossier.succeeded.map((item: any) => item.role),
          failed: [],
          malformed: [],
        },
        findings: [["correctness", "intent"], ["maintainability", "tests"], ["security"]].flatMap(
          (roles) => {
            const group = roles.flatMap((role) => (raw[role] ? [raw[role]] : []));
            return group.length === 0
              ? []
              : [{ ...group[0].finding, rawFindingIds: group.map((item) => item.id) }];
          },
        ),
        dismissals: raw["whole-change"]
          ? [
              {
                rawFindingId: raw["whole-change"].id,
                reason: "The formatting concern is outside this change's actionable scope.",
              },
            ]
          : [],
      });
      if (submitted.isError) throw new Error("Valid semantic consolidation was rejected");
      return submitted.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    }
    throw new Error(`Unexpected scripted node ${request.node.id}`);
  };
  const scriptedSubagent: DagEffectExecutor = (request) =>
    Effect.tryPromise({
      try: () => scriptedText(request),
      catch: (error) => new DagExecutorFailed({ message: String(error), error }),
    }).pipe(
      Effect.flatMap((text) =>
        publishDagSubagentTextResult(
          artifactRoot,
          request.runId,
          request.node.id,
          request.attemptId,
          (request.node.executor.payload as any).output.name,
          text,
        ),
      ),
    );
  const registry = {
    lookup: (kind: DagExecutorKind, key: string) =>
      Effect.succeed(
        kind === DagExecutorKind.Subagent && key === "pi/subagent-v1"
          ? scriptedSubagent
          : lookupRegisteredDagExecutor(sessionId, generation, kind, key),
      ),
  };
  const runtime = await DagSessionRuntime.create(pi, ctx, {
    sessionGeneration: generation,
    supervisor: {
      usage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }),
    } as any,
    telemetryRuntime: {} as any,
    ledger: {} as any,
    executorRegistry: registry,
  });
  cleanup.defer(() => runtime.dispose());
  const saved: ReviewState[] = [];
  const progress: unknown[] = [];
  let submissionState: ReviewState | undefined;
  let workspaceRoot: string | undefined;
  let reconstruction: DagSessionReconstruction;
  const service: DagRuntimeServiceRegistration["service"] = {
    ...services[0].service,
    submit: (graph, authority) => {
      customTools = authority?.customTools ?? [];
      workspaceRoot = authority?.workspaceRoot;
      submissionState = saved.at(-1);
      return services[0].service.submit(graph, authority);
    },
    reconstruct: (runId) =>
      services[0].service.reconstruct(runId).pipe(
        Effect.tap((value: DagSessionReconstruction) =>
          Effect.sync(() => {
            options.beforeCollection?.(artifactRoot, value);
          }),
        ),
      ),
  };
  let state: ReviewState;
  if (options.publicCreate) {
    const registration = registerDagRuntimeService(pi, {
      parentSessionId: sessionId,
      sessionGeneration: generation,
      service,
    });
    cleanup.defer(() => unregisterDagRuntimeService(pi, registration));
    state = await options.publicCreate.execute();
  } else {
    state = await runReviewDag({
      pi,
      ctx,
      service,
      assignments: resolvedAssignments,
      deckPath: deckPath!,
      state: initial!,
      onProgress: (update) => progress.push(update),
      save: (next) => {
        const persisted = structuredClone(next);
        options.onSave?.(persisted);
        saved.push(persisted);
        entries.push({
          type: "custom",
          customType: REVIEW_ENTRY_TYPE,
          data: { reviewId: persisted.snapshot.id, state: persisted },
        });
      },
    });
  }
  reconstruction = await Effect.runPromise(service.reconstruct(state.dag!.runId));
  await cleanup.disposeAsync();
  return {
    root,
    sessionDir,
    sessionId,
    artifactRoot,
    state,
    saved,
    submissionState,
    workspaceRoot,
    progress,
    rebuild: (persisted = { ...(initial ?? state), dag: state.dag }) =>
      reconstructReviewDagState({
        ctx,
        service: services[0].service,
        state: persisted,
        reconstruction,
      }),
    readDeck: (signal) => findTool("review_deck_").execute("retained-deck", {}, signal),
    entries,
    invalidSynthesisRejected,
    dossierRawIds,
    dossier,
    registeredTools,
    unregisteredTools,
    serviceDisposals,
  };
}
