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
import type {
  ActiveDagRuntimeService,
  DagRuntimeBudget,
  DagRuntimeUsage,
} from "../_shared/dag-runtime-service";
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
export const ReviewDagBudget = Object.freeze({
  maxTotalTokens: 55_000_000,
  maxCost: 70,
  maxTurns: 600,
} satisfies DagRuntimeBudget);
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
function nodeSucceeded(reconstruction: DagSessionReconstruction, nodeId: string): boolean {
  return reconstruction.state.nodes.some(
    (node) => node.nodeId === nodeId && node.status === DagNodeStatus.Succeeded,
  );
}
async function outputForNode(
  root: string,
  reconstruction: DagSessionReconstruction,
  nodeId: string,
): Promise<NodeOutput | undefined> {
  const node = reconstruction.state.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node || node.status !== DagNodeStatus.Succeeded) return undefined;
  const outputs = Object.entries(node.outputs);
  if (outputs.length !== 1) throw new Error(`DAG node ${nodeId} did not publish one output.`);
  const [outputName, reference] = outputs[0];
  return readVerifiedReviewArtifact(root, reference, {
    runId: reconstruction.graph.runId,
    producerNodeId: nodeId,
    outputName,
  });
}
async function admittedOutputForNode(
  root: string,
  reconstruction: DagSessionReconstruction,
  nodeId: string,
): Promise<NodeOutput | undefined> {
  try {
    return await outputForNode(root, reconstruction, nodeId);
  } catch {
    return undefined;
  }
}
function findingKey(finding: FindingInput): string {
  return JSON.stringify([
    finding.severity,
    finding.impact,
    finding.file,
    finding.side,
    finding.line,
    finding.problem,
    finding.consequence,
    finding.suggestedFix,
  ]);
}
function fallbackSynthesis(outputs: readonly ReviewerOutput[], diff: string): ReviewResult {
  const grouped = new Map<
    string,
    { finding: FindingInput; sources: Set<ReviewerOutput["role"]> }
  >();
  for (const output of outputs) {
    for (const finding of output.findings) {
      const key = findingKey(finding);
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
function findingInputFromSynthesis(finding: SynthesisReview["findings"][number]): FindingInput {
  const { sourceReviewers: _sourceReviewers, agreement: _agreement, ...input } = finding;
  return input;
}
function sameFinding(left: FindingInput, right: FindingInput): boolean {
  return findingKey(left) === findingKey(right);
}
function validSynthesisSources(
  synthesis: SynthesisReview,
  reviewers: readonly ReviewerOutput[],
): boolean {
  const reviewerByRole = new Map(reviewers.map((reviewer) => [reviewer.role, reviewer]));
  return synthesis.findings.every((finding) => {
    const uniqueSources = new Set(finding.sourceReviewers);
    const input = findingInputFromSynthesis(finding);
    return (
      finding.sourceReviewers.length === uniqueSources.size &&
      finding.agreement === uniqueSources.size &&
      finding.sourceReviewers.every((role) =>
        reviewerByRole.get(role)?.findings.some((candidate) => sameFinding(candidate, input)),
      )
    );
  });
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
    .filter((node) => node.status !== DagNodeStatus.Succeeded)
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
  const planOutput = await admittedOutputForNode(root, reconstruction, ReadingPlanNode.nodeId);
  const plan = planOutput ? decodePlan(planOutput.text, state) : undefined;
  if (nodeSucceeded(reconstruction, ReadingPlanNode.nodeId) && !plan)
    malformedNodes.push(ReadingPlanNode.nodeId);
  const reviewers: ReviewerOutput[] = [];
  const rawResultReferences: DagTextArtifactReference[] = [];
  for (const node of ReviewerNodes) {
    const output = await admittedOutputForNode(root, reconstruction, node.nodeId);
    if (!output) {
      if (nodeSucceeded(reconstruction, node.nodeId)) malformedNodes.push(node.nodeId);
      continue;
    }
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
    if (!Check(SynthesisReviewSchema, decoded) || !validSynthesisSources(decoded, reviewers))
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
export interface ReviewDagProgress {
  readonly runId: string;
  readonly nodes: Readonly<Record<string, string>>;
  readonly usage?: DagRuntimeUsage;
}

async function awaitSubmittedGraph(
  service: ActiveDagRuntimeService,
  graph: ValidatedDagDefinition<unknown>,
  workspaceRoot: string,
  onSubmitted: () => void,
  onProgress?: (progress: ReviewDagProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await Effect.runPromise(
    service.submit(graph, { workspaceRoot, budget: ReviewDagBudget }),
  );
  let pollActive = false;
  const reportProgress = async () => {
    if (!onProgress || pollActive) return;
    pollActive = true;
    try {
      const snapshot = await Effect.runPromise(handle.snapshot);
      onProgress({
        runId: graph.runId,
        nodes: Object.fromEntries(
          snapshot.state.nodes.map((node) => [node.nodeId, node.status]),
        ),
        ...(service.usage ? { usage: service.usage(graph.runId) } : {}),
      });
    } finally {
      pollActive = false;
    }
  };
  await Effect.runPromise(handle.accepted, { signal });
  onSubmitted();
  await reportProgress();
  const interval = onProgress ? setInterval(() => void reportProgress(), 2_000) : undefined;
  try {
    await Effect.runPromise(handle.await, { signal });
  } catch (cause) {
    if (!signal?.aborted) throw cause;
    await Effect.runPromise(Effect.result(handle.cancel));
  } finally {
    if (interval) clearInterval(interval);
    await reportProgress();
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
      submitted: state.dag?.submitted,
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
  const synthesisOutput = await admittedOutputForNode(
    input.root,
    input.reconstruction,
    SynthesisNode.nodeId,
  );
  if (nodeSucceeded(input.reconstruction, SynthesisNode.nodeId) && !synthesisOutput)
    collected.malformedNodes.push(SynthesisNode.nodeId);
  const diff = await import("node:fs/promises").then((fs) =>
    fs.readFile(input.state.snapshot.diffPath, "utf8"),
  );
  const synthesized = synthesisOutput
    ? decodeSynthesis(synthesisOutput.text, collected.reviewers, diff)
    : undefined;
  if (synthesisOutput && !synthesized) collected.malformedNodes.push(SynthesisNode.nodeId);
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
      submitted: input.state.dag?.submitted,
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
  readonly onProgress?: (progress: ReviewDagProgress) => void;
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
  try {
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
        submitted: false,
        rawResultReferences: [],
      },
    };
    options.save(state);
    await awaitSubmittedGraph(
      options.service,
      graph,
      state.snapshot.worktree,
      () => {
        state = { ...state, dag: { ...state.dag!, submitted: true } };
        options.save(state);
      },
      options.onProgress,
      options.signal,
    );
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
