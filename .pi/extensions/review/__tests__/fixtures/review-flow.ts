import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { onTestFinished } from "vitest";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
  DagExecutorKind,
  DagNodeStatus,
  materializeDagTextArtifact,
  publishDagSubagentTextResult,
  type DagEffectExecutor,
} from "../../../../../src/dag/index.js";
import { DagSessionRuntime } from "../../../subagent/dag-session-runtime";
import {
  lookupRegisteredDagExecutor,
  registerDagExecutor,
  unregisterDagExecutor,
} from "../../../_shared/dag-executor-registration";
import {
  listenForDagRuntimeService,
  resetDagRuntimeServiceRegistryForTests,
} from "../../../_shared/dag-runtime-service";
import { REVIEW_ENTRY_TYPE, type ReviewState } from "../../core";
import { buildReviewDeck } from "../../deck";
import {
  makeReviewEvidenceResolverExecutor,
  ReviewEvidenceCoverageOutput,
  ReviewEvidenceExecutorKind,
  ReviewEvidenceResolverKey,
} from "../../evidence-resolver";
import { EvidenceResolverNode, ReviewRoles, type ReviewRoleAssignments } from "../../review-graph";
import { runReviewDag } from "../../review-dag-runner";

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

export const assignments = Object.fromEntries(
  ReviewRoles.map((role, index) => [
    role,
    {
      model: index % 2 ? "provider-b/model" : "provider-a/model",
      reasoning: "high",
      contextWindow: 272_000,
    },
  ]),
) as ReviewRoleAssignments;

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
  readonly entries: readonly unknown[];
  readonly invalidSynthesisRejected: boolean;
  readonly dossierRawIds: readonly string[];
  readonly registeredTools: number;
  readonly unregisteredTools: number;
  readonly serviceDisposals: number;
}

/** A real offline DagSessionRuntime run. Only model output and the external GH boundary are faked. */
export async function runRealReviewFlow(
  beforeSynthesis?: (boundary: {
    artifactRoot: string;
    request: Parameters<DagEffectExecutor>[0];
    inspect: (signal?: AbortSignal) => Promise<any>;
  }) => Promise<void>,
): Promise<RealReviewFlow> {
  const { root, artifactRoot, ctx, state: initial } = reviewFixture();
  const { worktree, diffPath } = initial.snapshot;
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  const entries: unknown[] = ctx.sessionManager.getBranch();
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
  const deck = buildReviewDeck({ snapshot: initial.snapshot });
  const pi = eventsApi();
  const services: any[] = [];
  let serviceDisposals = 0;
  let registeredTools = 0;
  let unregisteredTools = 0;
  resetDagRuntimeServiceRegistryForTests();
  listenForDagRuntimeService(
    pi,
    (service) => services.push(service),
    () => serviceDisposals++,
  );
  pi.events.on("agent-tools:register", () => registeredTools++);
  pi.events.on("agent-tools:unregister", () => unregisteredTools++);
  const generation = "review-scenario";
  const evidenceRegistration = registerDagExecutor({
    parentSessionId: sessionId,
    sessionGeneration: generation,
    kind: ReviewEvidenceExecutorKind,
    key: ReviewEvidenceResolverKey,
    executor: makeReviewEvidenceResolverExecutor({ artifactRoot }),
  });
  const findTool = (prefix: string) => {
    const tool = [...pi.tools.values()].find((candidate) => candidate.name.startsWith(prefix));
    if (!tool) throw new Error(`Missing run-scoped tool ${prefix}`);
    return tool;
  };
  let invalidSynthesisRejected = false;
  let dossierRawIds: string[] = [];
  const scriptedText = async (request: Parameters<DagEffectExecutor>[0]) => {
    if (request.node.id === "reading-plan") {
      const submitted = await findTool("submit_review_plan_").execute(
        "plan",
        {
          goal: "Change the exported value.",
          goalAssessment: "The diff changes the value.",
          risk: "low",
          riskReasons: [],
          cohorts: [{ label: "code", purpose: "implementation", paths: ["a.ts"] }],
          files: [{ path: "a.ts", attention: "high", role: "implementation" }],
          evidence: [{ kind: "diff", path: "a.ts", startLine: 1, endLine: 12, purpose: "patch" }],
        },
        undefined,
        undefined,
      );
      if (submitted.isError) throw new Error("Reading plan was rejected");
      return submitted.content[0].text;
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
      return reviewer(role, JSON.parse(coverage.text).digest);
    }
    if (request.node.id === "synthesis") {
      const inspect = (signal?: AbortSignal) =>
        findTool("review_result_refs_").execute("refs", {}, signal, undefined);
      await beforeSynthesis?.({ artifactRoot, request, inspect });
      const refs = await inspect();
      if (refs.isError) throw new Error("Reviewer dossier was unavailable");
      const dossier = JSON.parse(refs.content[0].text);
      const raw = Object.fromEntries(
        dossier.succeeded.map((item: any) => [item.role, item.rawFindings[0]]),
      );
      dossierRawIds = dossier.succeeded.map((item: any) => item.rawFindings[0].id);
      const invalid = await findTool("submit_review_synthesis_").execute(
        "synthesis",
        {
          v: 2,
          verdict: "invalid accounting",
          coverage: { status: "complete", succeeded: [], failed: [], malformed: [] },
          findings: [{ ...raw.correctness.finding, rawFindingIds: ["R-invented"] }],
          dismissals: [],
        },
        undefined,
        undefined,
      );
      invalidSynthesisRejected = invalid.isError === true;
      const submitted = await findTool("submit_review_synthesis_").execute(
        "synthesis",
        {
          v: 2,
          verdict: "Editorial consolidation retained three actionable concerns.",
          coverage: {
            status: "complete",
            succeeded: dossier.succeeded.map((item: any) => item.role),
            failed: [],
            malformed: [],
          },
          findings: [
            { ...raw.correctness.finding, rawFindingIds: [raw.correctness.id, raw.intent.id] },
            {
              ...raw.maintainability.finding,
              rawFindingIds: [raw.maintainability.id, raw.tests.id],
            },
            { ...raw.security.finding, rawFindingIds: [raw.security.id] },
          ],
          dismissals: [
            {
              rawFindingId: raw["whole-change"].id,
              reason: "The formatting concern is outside this change's actionable scope.",
            },
          ],
        },
        undefined,
        undefined,
      );
      if (submitted.isError) throw new Error("Valid semantic consolidation was rejected");
      return submitted.content[0].text;
    }
    throw new Error(`Unexpected scripted node ${request.node.id}`);
  };
  const scriptedSubagent: DagEffectExecutor = (request) =>
    Effect.promise(async () =>
      Effect.runPromise(
        publishDagSubagentTextResult(
          artifactRoot,
          request.runId,
          request.node.id,
          request.attemptId,
          (request.node.executor.payload as any).output.name,
          await scriptedText(request),
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
  const runtime = await DagSessionRuntime.create(pi, ctx, new Map(), {
    sessionGeneration: generation,
    supervisor: {
      usage: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }),
    } as any,
    telemetryRuntime: {} as any,
    ledger: {} as any,
    executorRegistry: registry,
  });
  const saved: ReviewState[] = [];
  let state: ReviewState;
  try {
    state = await runReviewDag({
      pi,
      ctx,
      service: services[0].service,
      assignments,
      deckPath: deck.path,
      state: initial,
      save: (next) => {
        const persisted = structuredClone(next);
        saved.push(persisted);
        entries.push({
          type: "custom",
          customType: REVIEW_ENTRY_TYPE,
          data: { reviewId: persisted.snapshot.id, state: persisted },
        });
      },
    });
  } finally {
    await runtime.dispose();
    unregisterDagExecutor(evidenceRegistration);
    resetDagRuntimeServiceRegistryForTests();
  }
  return {
    root,
    sessionDir,
    sessionId,
    artifactRoot,
    state,
    saved,
    entries,
    invalidSynthesisRejected,
    dossierRawIds,
    registeredTools,
    unregisteredTools,
    serviceDisposals,
  };
}
