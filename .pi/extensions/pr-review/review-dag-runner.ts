import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { Effect } from "effect";
import {
  DagNodeStatus,
  DagRunOutcome,
  type DagSessionReconstruction,
  type DagTextArtifactReference,
  type ValidatedDagDefinition,
} from "../../../src/dag/index.js";
import type { ActiveDagRuntimeService, DagRuntimeUsage } from "../_shared/dag-runtime-service";
import { validateFindingAnchors, validatePlan } from "./core";
import { readVerifiedReviewArtifact, registerReviewDagTools } from "./dag-tools";
import {
  ReadingPlanNode,
  ReviewerNodes,
  SynthesisNode,
  compileReviewGraph,
  type ReviewRoleAssignments,
} from "./review-graph";
import {
  PlanSchema,
  ReviewerOutputSchema,
  SynthesisReviewSchema,
  type Finding,
  type FindingInput,
  type ReviewerOutput,
  type ReviewPlan,
  type ReviewResult,
  type ReviewState,
  type SynthesisReview,
} from "./schema";

type ReviewerRole = ReviewerOutput["role"];

const reviewerRoleByNode = new Map<string, ReviewerRole>(
  ReviewerNodes.map((node) => [node.nodeId, node.role]),
);
const AllReviewersFailed = "All PR reviewers failed or returned malformed output.";
type NodeOutput = { reference: DagTextArtifactReference; text: string };
interface CollectedOutputs {
  readonly plan?: ReviewPlan;
  readonly readingPlanReference?: DagTextArtifactReference;
  readonly reviewers: ReviewerOutput[];
  readonly rawResultReferences: DagTextArtifactReference[];
  readonly malformedNodes: string[];
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
function artifactRoot(ctx: ExtensionContext): string {
  return path.join(
    ctx.sessionManager.getSessionDir(),
    "dag-artifacts",
    ctx.sessionManager.getSessionId(),
  );
}
async function outputForNode(
  root: string,
  reconstruction: DagSessionReconstruction,
  nodeId: string,
): Promise<NodeOutput | undefined> {
  const node = reconstruction.state.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node || node.status !== DagNodeStatus.Succeeded) return undefined;
  const outputs = Object.values(node.outputs);
  if (outputs.length !== 1) throw new Error(`DAG node ${nodeId} did not publish one output.`);
  return readVerifiedReviewArtifact(root, outputs[0]);
}
function fallbackSynthesis(outputs: readonly ReviewerOutput[], diff: string): ReviewResult {
  const grouped = new Map<
    string,
    { finding: FindingInput; sources: Set<ReviewerOutput["role"]> }
  >();
  for (const output of outputs) {
    for (const finding of output.findings) {
      const key = JSON.stringify(finding);
      const existing = grouped.get(key);
      if (existing) existing.sources.add(output.role);
      else grouped.set(key, { finding, sources: new Set([output.role]) });
    }
  }
  const findings = [...grouped.values()].map(({ finding, sources }) => ({
    ...finding,
    sourceReviewers: [...sources].sort(),
    agreement: sources.size,
  }));
  return {
    ...validateFindingAnchors(
      {
        verdict: "Reviewer synthesis failed. Valid reviewer findings are preserved below.",
        findings: findings as Finding[],
      },
      diff,
    ),
    coverage: { status: "degraded", succeeded: [], failed: [], malformed: [] },
  };
}
function validSynthesisSources(
  synthesis: SynthesisReview,
  validRoles: ReadonlySet<ReviewerRole>,
): boolean {
  return synthesis.findings.every(
    (finding) =>
      finding.agreement === new Set(finding.sourceReviewers).size &&
      finding.sourceReviewers.every((role) => validRoles.has(role)),
  );
}
function outcomeStatus(
  reconstruction: DagSessionReconstruction,
  degraded: boolean,
): NonNullable<ReviewState["dag"]>["status"] {
  if (reconstruction.terminalOutcome === DagRunOutcome.Cancelled) return "cancelled";
  if (reconstruction.terminalOutcome === DagRunOutcome.Interrupted) return "interrupted";
  return degraded ? "degraded" : "succeeded";
}
function failedNodeIds(reconstruction: DagSessionReconstruction): string[] {
  return reconstruction.state.nodes
    .filter(
      (node) =>
        node.nodeId !== SynthesisNode.nodeId &&
        node.status !== DagNodeStatus.Succeeded,
    )
    .map((node) => node.nodeId)
    .sort();
}
function decodePlan(text: string, state: ReviewState): ReviewPlan | undefined {
  try {
    const decoded = parseJson(text);
    return Check(PlanSchema, decoded) &&
      validatePlan(decoded, state.snapshot.metadata.changedFiles).ok
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}
function decodeReviewer(text: string, expectedRole: ReviewerRole): ReviewerOutput | undefined {
  try {
    const decoded = parseJson(text);
    return Check(ReviewerOutputSchema, decoded) && decoded.role === expectedRole
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}
async function collectOutputs(
  root: string,
  reconstruction: DagSessionReconstruction,
  state: ReviewState,
): Promise<CollectedOutputs> {
  const malformedNodes: string[] = [];
  const planOutput = await outputForNode(root, reconstruction, ReadingPlanNode.nodeId);
  const plan = planOutput ? decodePlan(planOutput.text, state) : undefined;
  if (planOutput && !plan) malformedNodes.push(ReadingPlanNode.nodeId);
  const reviewers: ReviewerOutput[] = [];
  const rawResultReferences: DagTextArtifactReference[] = [];
  for (const node of ReviewerNodes) {
    const output = await outputForNode(root, reconstruction, node.nodeId);
    if (!output) continue;
    rawResultReferences.push(output.reference);
    const reviewer = decodeReviewer(output.text, node.role);
    if (reviewer) reviewers.push(reviewer);
    else malformedNodes.push(node.nodeId);
  }
  return {
    ...(plan ? { plan } : {}),
    ...(planOutput ? { readingPlanReference: planOutput.reference } : {}),
    reviewers,
    rawResultReferences,
    malformedNodes,
  };
}
function decodeSynthesis(
  text: string,
  reviewers: readonly ReviewerOutput[],
  diff: string,
): ReviewResult | undefined {
  try {
    const decoded = parseJson(text);
    const validRoles = new Set(reviewers.map((output) => output.role));
    if (!Check(SynthesisReviewSchema, decoded) || !validSynthesisSources(decoded, validRoles))
      return undefined;
    const validated = validateFindingAnchors(
      { verdict: decoded.verdict, findings: decoded.findings as Finding[] },
      diff,
    );
    return { ...validated, coverage: decoded.coverage };
  } catch {
    return undefined;
  }
}
function reviewerRolesForNodes(nodeIds: readonly string[]): ReviewerRole[] {
  return nodeIds
    .map((nodeId) => reviewerRoleByNode.get(nodeId))
    .filter((role): role is ReviewerRole => role !== undefined)
    .sort();
}
function reviewMetrics(input: {
  readonly state: ReviewState;
  readonly startedAt: number;
  readonly references: readonly { readonly bytes: number }[];
  readonly succeeded: number;
  readonly failed: number;
  readonly malformed: number;
  readonly result?: ReviewResult;
  readonly usage?: DagRuntimeUsage;
}): NonNullable<ReviewState["metrics"]> {
  const findings = input.result?.findings ?? [];
  return {
    durationMs: Math.max(0, Date.now() - input.startedAt),
    deckBytes: input.state.deck?.bytes ?? 0,
    reviewerOutputBytes: input.references.reduce((total, reference) => total + reference.bytes, 0),
    reviewersSucceeded: input.succeeded,
    reviewersFailed: input.failed,
    reviewersMalformed: input.malformed,
    findings: findings.length,
    anchoredFindings: findings.filter((finding) => finding.anchorValid).length,
    ...(input.usage ? { usage: input.usage } : {}),
  };
}
async function awaitSubmittedGraph(
  service: ActiveDagRuntimeService,
  graph: ValidatedDagDefinition<unknown>,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await Effect.runPromise(service.submit(graph, { workspaceRoot }));
  try {
    await Effect.runPromise(handle.await, { signal });
  } catch (cause) {
    if (!signal?.aborted) throw cause;
    await Effect.runPromise(Effect.result(handle.cancel));
  }
}
function noReviewerStatus(
  reconstruction: DagSessionReconstruction,
): NonNullable<ReviewState["dag"]>["status"] {
  if (reconstruction.terminalOutcome === DagRunOutcome.Cancelled) return "cancelled";
  if (reconstruction.terminalOutcome === DagRunOutcome.Interrupted) return "interrupted";
  return "failed";
}
function preserveAllFailedOutputs(
  state: ReviewState,
  runId: string,
  reconstruction: DagSessionReconstruction,
  collected: CollectedOutputs,
  failedNodes: string[],
): ReviewState {
  return {
    ...state,
    dag: {
      runId,
      startedAt: state.dag?.startedAt,
      status: noReviewerStatus(reconstruction),
      rawResultReferences: collected.rawResultReferences,
      ...(collected.readingPlanReference
        ? { readingPlanReference: collected.readingPlanReference }
        : {}),
      failedNodes,
      malformedNodes: [...new Set(collected.malformedNodes)].sort(),
      error: AllReviewersFailed,
      recoveredFromProcessLoss: reconstruction.recoveredFromProcessLoss,
    },
  };
}
async function finalizeReview(input: {
  readonly root: string;
  readonly runId: string;
  readonly state: ReviewState;
  readonly reconstruction: DagSessionReconstruction;
  readonly service: ActiveDagRuntimeService;
  readonly startedAt: number;
}): Promise<ReviewState> {
  const failedNodes = failedNodeIds(input.reconstruction);
  const collected = await collectOutputs(input.root, input.reconstruction, input.state);
  if (collected.reviewers.length === 0)
    return preserveAllFailedOutputs(
      input.state,
      input.runId,
      input.reconstruction,
      collected,
      failedNodes,
    );
  const synthesisOutput = await outputForNode(
    input.root,
    input.reconstruction,
    SynthesisNode.nodeId,
  );
  const diff = await import("node:fs/promises").then((fs) =>
    fs.readFile(input.state.snapshot.diffPath, "utf8"),
  );
  const synthesized = synthesisOutput
    ? decodeSynthesis(synthesisOutput.text, collected.reviewers, diff)
    : undefined;
  if (synthesisOutput && !synthesized)
    collected.malformedNodes.push(SynthesisNode.nodeId);
  const result = synthesized ?? fallbackSynthesis(collected.reviewers, diff);
  const successfulRoles = collected.reviewers.map((output) => output.role).sort();
  const failedRoles = reviewerRolesForNodes(failedNodes);
  const malformedRoles = reviewerRolesForNodes(collected.malformedNodes);
  const degraded =
    failedNodes.length > 0 ||
    collected.malformedNodes.length > 0 ||
    !collected.plan ||
    !synthesisOutput;
  result.coverage = {
    status: degraded ? "degraded" : "complete",
    succeeded: successfulRoles,
    failed: failedRoles,
    malformed: malformedRoles,
  };
  return {
    ...input.state,
    metrics: reviewMetrics({
      state: input.state,
      startedAt: input.startedAt,
      references: collected.rawResultReferences,
      succeeded: successfulRoles.length,
      failed: failedRoles.length,
      malformed: malformedRoles.length,
      result,
      usage: input.service.usage?.(input.runId),
    }),
    ...(collected.plan ? { plan: collected.plan } : {}),
    result,
    selectedFindingIds: result.findings.flatMap((finding) =>
      finding.selected && finding.id ? [finding.id] : [],
    ),
    dag: {
      runId: input.runId,
      startedAt: input.state.dag?.startedAt,
      status: outcomeStatus(input.reconstruction, degraded),
      rawResultReferences: collected.rawResultReferences,
      ...(collected.readingPlanReference
        ? { readingPlanReference: collected.readingPlanReference }
        : {}),
      ...(synthesisOutput ? { synthesisReference: synthesisOutput.reference } : {}),
      failedNodes,
      malformedNodes: [...new Set(collected.malformedNodes)].sort(),
      recoveredFromProcessLoss: input.reconstruction.recoveredFromProcessLoss,
    },
  };
}
function failedRunState(
  state: ReviewState,
  runId: string,
  cause: unknown,
  startedAt: number,
  service: ActiveDagRuntimeService,
  aborted: boolean,
): ReviewState {
  const references = state.dag?.rawResultReferences ?? [];
  return {
    ...state,
    metrics:
      state.metrics ??
      reviewMetrics({
        state,
        startedAt,
        references,
        succeeded: 0,
        failed: state.dag?.failedNodes?.length ?? 0,
        malformed: state.dag?.malformedNodes?.length ?? 0,
        result: state.result,
        usage: service.usage?.(runId),
      }),
    dag: {
      ...state.dag,
      runId,
      status: aborted ? "cancelled" : "failed",
      rawResultReferences: references,
      error: cause instanceof Error ? cause.message : String(cause),
    },
  };
}

export async function reconstructReviewDagState(options: {
  readonly ctx: ExtensionContext;
  readonly service: ActiveDagRuntimeService;
  readonly state: ReviewState;
  readonly reconstruction: DagSessionReconstruction;
}): Promise<ReviewState> {
  if (!options.state.dag) throw new Error("Cannot reconstruct PR review state without a DAG run.");
  const parsedStart = Date.parse(options.state.dag.startedAt ?? "");
  return finalizeReview({
    root: artifactRoot(options.ctx),
    runId: options.state.dag.runId,
    state: options.state,
    reconstruction: options.reconstruction,
    service: options.service,
    startedAt: Number.isFinite(parsedStart) ? parsedStart : Date.now(),
  });
}

export async function runReviewDag(options: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly signal?: AbortSignal;
  readonly service: ActiveDagRuntimeService;
  readonly assignments: ReviewRoleAssignments;
  readonly deckPath: string;
  readonly state: ReviewState;
  readonly save: (state: ReviewState) => void;
}): Promise<ReviewState> {
  const startedAt = Date.now();
  let state = options.state;
  const runId = `pr-review-${state.snapshot.id}`;
  const store = {
    get state() {
      return state;
    },
    set state(next: ReviewState) {
      state = next;
    },
    save(next: ReviewState) {
      state = next;
      options.save(next);
    },
  };
  const root = artifactRoot(options.ctx);
  const tools = registerReviewDagTools({
    pi: options.pi,
    reviewId: state.snapshot.id,
    runId,
    deckPath: options.deckPath,
    artifactRoot: root,
    store,
    service: options.service,
  });
  const graph = compileReviewGraph({
    runId,
    cwd: state.snapshot.worktree,
    assignments: options.assignments,
    tools: tools.names,
  });
  state = {
    ...state,
    dag: {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      status: "running",
      rawResultReferences: [],
    },
  };
  options.save(state);
  try {
    await awaitSubmittedGraph(options.service, graph, state.snapshot.worktree, options.signal);
    const reconstruction = await Effect.runPromise(options.service.reconstruct(runId));
    state = await finalizeReview({
      root,
      runId,
      state,
      reconstruction,
      service: options.service,
      startedAt,
    });
    options.save(state);
    if (state.dag?.error === AllReviewersFailed) throw new Error(AllReviewersFailed);
    return state;
  } catch (cause) {
    const next = failedRunState(
      state,
      runId,
      cause,
      startedAt,
      options.service,
      options.signal?.aborted === true,
    );
    options.save(next);
    throw cause;
  } finally {
    tools.unregister();
  }
}
