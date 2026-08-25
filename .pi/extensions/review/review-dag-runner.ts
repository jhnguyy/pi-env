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
import { registerReviewDagTools } from "./dag-tools";
import {
  admitReviewerDossier,
  readVerifiedReviewArtifact,
  type ReviewerDossier,
} from "./reviewer-dossier";
import {
  EvidenceResolverNode,
  ReadingPlanNode,
  ReviewerNodes,
  SynthesisNode,
  compileReviewGraph,
  type ReviewRoleAssignments,
} from "./review-graph";
import {
  ReviewEvidenceCoverageOutput,
  ReviewEvidenceOutputs,
  type ReviewEvidenceCoverage,
} from "./evidence-resolver";
import {
  PlanSchema,
  type Finding,
  type FindingInput,
  type ReviewerOutput,
  type ReviewPlan,
  type ReviewResult,
  type ReviewState,
  type SynthesisReview,
  validateSynthesisReviewShape,
} from "./schema";
import { findingKey, validSynthesisSources } from "./synthesis-provenance";

type ReviewerRole = ReviewerOutput["role"];

const reviewerRoleByNode = new Map<string, ReviewerRole>(
  ReviewerNodes.map((node) => [node.nodeId, node.role]),
);
const AllReviewersFailed = "All PR reviewers failed or returned malformed output.";
type NodeOutput = { reference: DagTextArtifactReference; text: string };
interface CollectedOutputs {
  readonly plan?: ReviewPlan;
  readonly readingPlanReference?: DagTextArtifactReference;
  readonly evidenceCoverage?: ReviewEvidenceCoverage;
  readonly evidenceReferences: DagTextArtifactReference[];
  readonly reviewers: ReviewerOutput[];
  readonly rawResultReferences: DagTextArtifactReference[];
  readonly failedReviewerNodes: string[];
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
async function admittedOutputForNodeOutput(
  root: string,
  reconstruction: DagSessionReconstruction,
  nodeId: string,
  outputName: string,
): Promise<NodeOutput | undefined> {
  const node = reconstruction.state.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node || node.status !== DagNodeStatus.Succeeded || !node.outputs[outputName])
    return undefined;
  try {
    return await readVerifiedReviewArtifact(root, node.outputs[outputName], {
      runId: reconstruction.graph.runId,
      producerNodeId: nodeId,
      outputName,
    });
  } catch {
    return undefined;
  }
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
function decodeEvidenceCoverage(text: string): ReviewEvidenceCoverage | undefined {
  try {
    const decoded = parseJson(text) as Partial<ReviewEvidenceCoverage>;
    return decoded.v === 1 &&
      typeof decoded.digest === "string" &&
      /^[0-9a-f]{64}$/u.test(decoded.digest) &&
      typeof decoded.uniqueBytes === "number" &&
      typeof decoded.dossierBytes === "number" &&
      typeof decoded.chunks === "number" &&
      Array.isArray(decoded.omissions)
      ? (decoded as ReviewEvidenceCoverage)
      : undefined;
  } catch {
    return undefined;
  }
}
async function collectEvidence(
  root: string,
  reconstruction: DagSessionReconstruction,
): Promise<{
  coverage?: ReviewEvidenceCoverage;
  references: DagTextArtifactReference[];
  malformed: boolean;
}> {
  const node = reconstruction.state.nodes.find(
    (candidate) => candidate.nodeId === EvidenceResolverNode.nodeId,
  );
  if (node?.status !== DagNodeStatus.Succeeded) return { references: [], malformed: false };
  const references: DagTextArtifactReference[] = [];
  let coverage: ReviewEvidenceCoverage | undefined;
  for (const outputName of ReviewEvidenceOutputs) {
    const output = await admittedOutputForNodeOutput(
      root,
      reconstruction,
      EvidenceResolverNode.nodeId,
      outputName,
    );
    if (!output) continue;
    references.push(output.reference);
    if (outputName === ReviewEvidenceCoverageOutput) coverage = decodeEvidenceCoverage(output.text);
  }
  return {
    ...(coverage ? { coverage } : {}),
    references,
    malformed: references.length !== ReviewEvidenceOutputs.length || !coverage,
  };
}
async function collectOutputs(
  root: string,
  reconstruction: DagSessionReconstruction,
  state: ReviewState,
  admittedDossier?: Promise<ReviewerDossier>,
): Promise<CollectedOutputs> {
  const planOutput = await admittedOutputForNode(root, reconstruction, ReadingPlanNode.nodeId);
  const plan = planOutput ? decodePlan(planOutput.text, state) : undefined;
  const evidence = await collectEvidence(root, reconstruction);
  const dossier = admittedDossier
    ? await admittedDossier
    : await admitReviewerDossier({
        artifactRoot: root,
        reconstruction,
        expectedEvidenceDigest: evidence.coverage?.digest,
      });
  const malformedNodes = [...dossier.malformed];
  if (nodeSucceeded(reconstruction, ReadingPlanNode.nodeId) && !plan)
    malformedNodes.push(ReadingPlanNode.nodeId);
  if (evidence.malformed) malformedNodes.push(EvidenceResolverNode.nodeId);
  return {
    ...(plan ? { plan } : {}),
    ...(planOutput ? { readingPlanReference: planOutput.reference } : {}),
    ...(evidence.coverage ? { evidenceCoverage: evidence.coverage } : {}),
    evidenceReferences: evidence.references,
    reviewers: dossier.admitted.map((artifact) => artifact.reviewer),
    rawResultReferences: dossier.raw.map((artifact) => artifact.reference),
    failedReviewerNodes: [...dossier.failed],
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
    if (!validateSynthesisReviewShape(decoded) || !validSynthesisSources(decoded, reviewers))
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
  readonly evidence?: ReviewEvidenceCoverage;
  readonly reviewerAttempts?: number;
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
    ...(input.evidence
      ? {
          evidence: {
            digest: input.evidence.digest,
            uniqueBytes: input.evidence.uniqueBytes,
            dossierBytes: input.evidence.dossierBytes,
            chunks: input.evidence.chunks,
            omissions: input.evidence.omissions.length,
            providerRequests: input.reviewerAttempts ?? 0,
            reviewerTurns: input.reviewerAttempts ?? 0,
          },
        }
      : {}),
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
  const handle = await Effect.runPromise(service.submit(graph, { workspaceRoot }));
  let pollActive = false;
  const reportProgress = async () => {
    if (!onProgress || pollActive) return;
    pollActive = true;
    try {
      const snapshot = await Effect.runPromise(handle.snapshot);
      onProgress({
        runId: graph.runId,
        nodes: Object.fromEntries(snapshot.state.nodes.map((node) => [node.nodeId, node.status])),
        ...(service.usage ? { usage: service.usage(graph.runId) } : {}),
      });
    } finally {
      pollActive = false;
    }
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  try {
    await Effect.runPromise(handle.accepted, { signal });
    onSubmitted();
    await reportProgress();
    interval = onProgress ? setInterval(() => void reportProgress(), 2_000) : undefined;
    await Effect.runPromise(handle.await, { signal });
  } catch (cause) {
    await Effect.runPromise(Effect.result(handle.cancel));
    if (!signal?.aborted) throw cause;
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
function failureMessageForNode(
  reconstruction: DagSessionReconstruction,
  nodeId: string,
): string | undefined {
  const node = reconstruction.state.nodes.find((candidate) => candidate.nodeId === nodeId);
  const failure = node && "failure" in node ? node.failure : undefined;
  if (!failure || typeof failure !== "object") return undefined;
  const value = failure as { message?: unknown; error?: { message?: unknown; code?: unknown } };
  const message =
    typeof value.error?.message === "string"
      ? value.error.message
      : typeof value.message === "string"
        ? value.message
        : undefined;
  const code = typeof value.error?.code === "string" ? value.error.code : undefined;
  return message ? `${code ? `${code}: ` : ""}${message}` : code;
}
function preserveAllFailedOutputs(
  state: ReviewState,
  runId: string,
  reconstruction: DagSessionReconstruction,
  collected: CollectedOutputs,
  failedNodes: string[],
): ReviewState {
  const evidenceFailure = failureMessageForNode(reconstruction, EvidenceResolverNode.nodeId);
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
      evidenceReferences: collected.evidenceReferences,
      ...evidenceCoverageState(collected.evidenceCoverage),
      failedNodes,
      malformedNodes: [...new Set(collected.malformedNodes)].sort(),
      error: evidenceFailure
        ? `Evidence resolution failed: ${evidenceFailure}`
        : AllReviewersFailed,
      recoveredFromProcessLoss: reconstruction.recoveredFromProcessLoss,
    },
  };
}
interface FinalizeReviewInput {
  readonly root: string;
  readonly runId: string;
  readonly state: ReviewState;
  readonly reconstruction: DagSessionReconstruction;
  readonly service: ActiveDagRuntimeService;
  readonly startedAt: number;
  readonly reviewerDossier?: Promise<ReviewerDossier>;
}
async function resolveSynthesis(input: FinalizeReviewInput, collected: CollectedOutputs) {
  const output = await admittedOutputForNode(
    input.root,
    input.reconstruction,
    SynthesisNode.nodeId,
  );
  if (nodeSucceeded(input.reconstruction, SynthesisNode.nodeId) && !output)
    collected.malformedNodes.push(SynthesisNode.nodeId);
  const diff = await import("node:fs/promises").then((fs) =>
    fs.readFile(input.state.snapshot.diffPath, "utf8"),
  );
  const synthesized = output ? decodeSynthesis(output.text, collected.reviewers, diff) : undefined;
  if (output && !synthesized) collected.malformedNodes.push(SynthesisNode.nodeId);
  return { output, result: synthesized ?? fallbackSynthesis(collected.reviewers, diff) };
}
function reviewerAttemptCount(reconstruction: DagSessionReconstruction): number {
  return reconstruction.state.nodes.filter(
    (node) =>
      reviewerRoleByNode.has(node.nodeId) &&
      (node.status === DagNodeStatus.Succeeded || node.status === DagNodeStatus.Failed),
  ).length;
}
function evidenceCoverageState(coverage: ReviewEvidenceCoverage | undefined) {
  if (!coverage) return {};
  return {
    evidenceCoverage: {
      digest: coverage.digest,
      uniqueBytes: coverage.uniqueBytes,
      dossierBytes: coverage.dossierBytes,
      chunks: coverage.chunks,
      omissions: [...coverage.omissions],
    },
  };
}
function finalizedReviewState(
  input: FinalizeReviewInput,
  collected: CollectedOutputs,
  failedNodes: string[],
  synthesis: Awaited<ReturnType<typeof resolveSynthesis>>,
): ReviewState {
  const successfulRoles = collected.reviewers.map((output) => output.role).sort();
  const failedRoles = reviewerRolesForNodes(failedNodes);
  const malformedRoles = reviewerRolesForNodes(collected.malformedNodes);
  const degraded =
    failedNodes.length > 0 ||
    collected.malformedNodes.length > 0 ||
    (collected.evidenceCoverage?.omissions.length ?? 0) > 0 ||
    !collected.plan ||
    !synthesis.output;
  synthesis.result.coverage = {
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
      result: synthesis.result,
      evidence: collected.evidenceCoverage,
      reviewerAttempts: reviewerAttemptCount(input.reconstruction),
      usage: input.service.usage?.(input.runId),
    }),
    ...(collected.plan ? { plan: collected.plan } : {}),
    result: synthesis.result,
    selectedFindingIds: synthesis.result.findings.flatMap((finding) =>
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
      evidenceReferences: collected.evidenceReferences,
      ...evidenceCoverageState(collected.evidenceCoverage),
      ...(synthesis.output ? { synthesisReference: synthesis.output.reference } : {}),
      failedNodes,
      malformedNodes: [...new Set(collected.malformedNodes)].sort(),
      recoveredFromProcessLoss: input.reconstruction.recoveredFromProcessLoss,
    },
  };
}
async function finalizeReview(input: FinalizeReviewInput): Promise<ReviewState> {
  const collected = await collectOutputs(
    input.root,
    input.reconstruction,
    input.state,
    input.reviewerDossier,
  );
  const failedNodes = [
    ...new Set([...failedNodeIds(input.reconstruction), ...collected.failedReviewerNodes]),
  ].sort();
  if (collected.reviewers.length === 0)
    return preserveAllFailedOutputs(
      input.state,
      input.runId,
      input.reconstruction,
      collected,
      failedNodes,
    );
  const synthesis = await resolveSynthesis(input, collected);
  return finalizedReviewState(input, collected, failedNodes, synthesis);
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
  const runId = `review-pr-${state.snapshot.id}`;
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
  const evidence = {
    v: 1 as const,
    snapshotId: state.snapshot.id,
    headOid: state.snapshot.metadata.headOid,
    diffHash: state.snapshot.diffHash,
    worktree: state.snapshot.worktree,
    diffPath: state.snapshot.diffPath,
    changedPaths: state.snapshot.metadata.changedFiles.map((file) => file.path),
    planOutputName: ReadingPlanNode.outputName,
    reviewerContextWindow: Math.min(
      ...ReviewerNodes.map((node) => options.assignments[node.role].contextWindow),
    ),
  };
  const tools = registerReviewDagTools({
    pi: options.pi,
    reviewId: state.snapshot.id,
    runId,
    deckPath: options.deckPath,
    artifactRoot: root,
    store,
    service: options.service,
    evidence,
  });
  try {
    const graph = compileReviewGraph({
      runId,
      cwd: state.snapshot.worktree,
      assignments: options.assignments,
      tools: tools.names,
      evidence,
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
      reviewerDossier: tools.reviewerDossier(options.signal),
    });
    options.save(state);
    if (state.dag?.error) throw new Error(state.dag.error);
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
