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
import type * as DagRuntimeService from "../_shared/dag-runtime-service";
import { validateFindingAnchors, validatePlan } from "./core";
import * as DagTools from "./dag-tools";
import { readVerifiedPinnedDiff } from "./snapshot";
import { selectedFindings } from "./decision";
import {
  admitReviewArtifacts,
  type ReviewAdmission,
  readVerifiedReviewArtifact,
} from "./reviewer-dossier";
import {
  EvidenceResolverNode,
  ReadingPlanNode,
  ReviewerNodes,
  SynthesisNode,
  compileReviewGraph,
  type ReviewRoleAssignments,
} from "./review-graph";
import type { ReviewEvidenceCoverage } from "./evidence-resolver";
import {
  PlanSchema,
  type AdmittedRawFinding,
  type Finding,
  type ReviewerOutput,
  type ReviewPlan,
  type ReviewResult,
  type ReviewState,
  validateConsolidationReviewV2Shape,
  validateSynthesisReviewShape,
} from "./schema";
import {
  consolidateSynthesis,
  fallbackConsolidation,
  validSynthesisSources,
} from "./synthesis-provenance";

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
  readonly evidenceReferences: readonly DagTextArtifactReference[];
  readonly reviewers: ReviewerOutput[];
  readonly rawFindings: readonly AdmittedRawFinding[];
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
  expectedOutputName: string,
): Promise<NodeOutput | undefined> {
  const node = reconstruction.state.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node || node.status !== DagNodeStatus.Succeeded) return undefined;
  const reference = node.outputs[expectedOutputName];
  if (!reference || Object.keys(node.outputs).length !== 1)
    throw new Error(`DAG node ${nodeId} did not publish its topology output.`);
  return readVerifiedReviewArtifact(root, reference, {
    runId: reconstruction.graph.runId,
    producerNodeId: nodeId,
    outputName: expectedOutputName,
  });
}
async function admittedOutputForNode(
  root: string,
  reconstruction: DagSessionReconstruction,
  nodeId: string,
  expectedOutputName: string,
): Promise<NodeOutput | undefined> {
  try {
    return await outputForNode(root, reconstruction, nodeId, expectedOutputName);
  } catch {
    return undefined;
  }
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
    .filter((node) => node.status === DagNodeStatus.Failed)
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
async function collectOutputs(
  root: string,
  reconstruction: DagSessionReconstruction,
  state: ReviewState,
  admitted?: Promise<ReviewAdmission>,
): Promise<CollectedOutputs> {
  const { evidence, reviewers: dossier } = await (admitted ??
    admitReviewArtifacts(root, reconstruction));
  const planOutput = await admittedOutputForNode(
    root,
    reconstruction,
    ReadingPlanNode.nodeId,
    ReadingPlanNode.outputName,
  );
  const plan = planOutput ? decodePlan(planOutput.text, state) : undefined;
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
    rawFindings: dossier.rawFindings,
    rawResultReferences: dossier.raw.map((artifact) => artifact.reference),
    failedReviewerNodes: [...dossier.failed],
    malformedNodes,
  };
}
function decodeSynthesis(
  text: string,
  rawFindings: readonly AdmittedRawFinding[],
  reviewers: readonly ReviewerOutput[],
  diff: string,
  protocol: 2 | "legacy" | "unsupported",
): ReviewResult | undefined {
  try {
    const decoded = parseJson(text);
    if (protocol === "unsupported") return undefined;
    if (validateConsolidationReviewV2Shape(decoded)) {
      const consolidated = consolidateSynthesis(decoded, rawFindings);
      return consolidated ? validateFindingAnchors(consolidated, diff) : undefined;
    }
    if (
      protocol === "legacy" &&
      validateSynthesisReviewShape(decoded) &&
      validSynthesisSources(decoded, reviewers)
    ) {
      const validated = validateFindingAnchors(
        { verdict: decoded.verdict, findings: decoded.findings as Finding[] },
        diff,
      );
      return { ...validated, coverage: decoded.coverage };
    }
    return undefined;
  } catch {
    return undefined;
  }
}
function reviewerRolesForNodes(nodeIds: readonly string[]): ReviewerRole[] {
  return nodeIds
    .flatMap((nodeId) => {
      const role = reviewerRoleByNode.get(nodeId);
      return role === undefined ? [] : [role];
    })
    .sort();
}
function reviewMetrics(input: {
  readonly state: ReviewState;
  readonly startedAt: number;
  readonly references: readonly { readonly bytes: number }[];
  readonly succeeded: number;
  readonly failed: number;
  readonly malformed: number;
  readonly blocked: number;
  readonly result?: ReviewResult;
  readonly evidence?: ReviewEvidenceCoverage;
  readonly reviewerAttempts?: number;
  readonly usage?: DagRuntimeService.DagRuntimeUsage;
}): NonNullable<ReviewState["metrics"]> {
  const findings = input.result?.findings ?? [];
  return {
    durationMs: Math.max(0, Date.now() - input.startedAt),
    deckBytes: input.state.deck?.bytes ?? 0,
    reviewerOutputBytes: input.references.reduce((total, reference) => total + reference.bytes, 0),
    reviewersSucceeded: input.succeeded,
    reviewersFailed: input.failed,
    reviewersMalformed: input.malformed,
    reviewersBlocked: input.blocked,
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
  readonly reviewId: string;
  readonly runId: string;
  readonly nodes: Readonly<Record<string, string>>;
  readonly usage?: DagRuntimeService.DagRuntimeUsage;
}

async function awaitSubmittedGraph(
  service: DagRuntimeService.ActiveDagRuntimeService,
  graph: ValidatedDagDefinition<unknown>,
  authority: DagRuntimeService.DagRuntimeSubmissionAuthority,
  reviewId: string,
  onSubmitted: () => void,
  onProgress?: (progress: ReviewDagProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await Effect.runPromise(service.submit(graph, authority));
  let pollActive = false;
  const reportProgress = async () => {
    if (!onProgress || pollActive) return;
    pollActive = true;
    try {
      const snapshot = await Effect.runPromise(handle.snapshot);
      onProgress({
        reviewId,
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
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
function failureForNode(
  reconstruction: DagSessionReconstruction,
  nodeId: string,
): NonNullable<NonNullable<ReviewState["dag"]>["failure"]> | undefined {
  const node = reconstruction.state.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node?.status !== DagNodeStatus.Failed) return undefined;
  const failure = record(node.failure);
  const error = record(failure?.error);
  const details = record(error?.cause);
  const message = [details?.errorMessage, error?.message, failure?.message].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!message) return undefined;
  const code = typeof error?.code === "string" ? `${error.code}: ` : "";
  return {
    nodeId,
    message: `${code}${message}`.slice(0, 1024),
    ...(typeof details?.sessionFile === "string" ? { sessionFile: details.sessionFile } : {}),
  };
}
function blockedNodeIds(reconstruction: DagSessionReconstruction): string[] {
  return reconstruction.state.nodes
    .filter((node) => node.status === DagNodeStatus.Blocked)
    .map((node) => node.nodeId)
    .sort();
}
function preserveAllFailedOutputs(
  state: ReviewState,
  runId: string,
  reconstruction: DagSessionReconstruction,
  collected: CollectedOutputs,
  failedNodes: string[],
  startedAt: number,
  usage: DagRuntimeService.DagRuntimeUsage | undefined,
): ReviewState {
  const blockedNodes = blockedNodeIds(reconstruction);
  const failure = failedNodes
    .filter((nodeId) => nodeId !== SynthesisNode.nodeId)
    .flatMap((nodeId) => {
      const value = failureForNode(reconstruction, nodeId);
      return value ? [value] : [];
    })[0];
  return {
    ...state,
    ...(collected.plan ? { plan: collected.plan } : {}),
    metrics: reviewMetrics({
      state,
      startedAt,
      references: collected.rawResultReferences,
      succeeded: 0,
      failed: reviewerRolesForNodes(failedNodes).length,
      malformed: reviewerRolesForNodes(collected.malformedNodes).length,
      blocked: reviewerRolesForNodes(blockedNodes).length,
      evidence: collected.evidenceCoverage,
      reviewerAttempts: reviewerAttemptCount(reconstruction),
      usage,
    }),
    dag: {
      runId,
      startedAt: state.dag?.startedAt,
      submitted: state.dag?.submitted,
      ...(state.dag?.synthesisProtocol === undefined
        ? {}
        : { synthesisProtocol: state.dag.synthesisProtocol }),
      status: noReviewerStatus(reconstruction),
      rawResultReferences: collected.rawResultReferences,
      ...(collected.readingPlanReference
        ? { readingPlanReference: collected.readingPlanReference }
        : {}),
      evidenceReferences: [...collected.evidenceReferences],
      ...evidenceCoverageState(collected.evidenceCoverage),
      failedNodes,
      blockedNodes,
      malformedNodes: [...new Set(collected.malformedNodes)].sort(),
      ...(failure ? { failure } : {}),
      error: failure ? `${failure.nodeId}: ${failure.message}` : AllReviewersFailed,
      recoveredFromProcessLoss: reconstruction.recoveredFromProcessLoss,
    },
  };
}
interface FinalizeReviewInput {
  readonly root: string;
  readonly runId: string;
  readonly state: ReviewState;
  readonly reconstruction: DagSessionReconstruction;
  readonly service: DagRuntimeService.ActiveDagRuntimeService;
  readonly startedAt: number;
  readonly admission?: Promise<ReviewAdmission>;
  readonly synthesisProtocol: 2 | "legacy" | "unsupported";
}
async function resolveSynthesis(input: FinalizeReviewInput, collected: CollectedOutputs) {
  const output = await admittedOutputForNode(
    input.root,
    input.reconstruction,
    SynthesisNode.nodeId,
    SynthesisNode.outputName,
  );
  if (nodeSucceeded(input.reconstruction, SynthesisNode.nodeId) && !output)
    collected.malformedNodes.push(SynthesisNode.nodeId);
  const diff = readVerifiedPinnedDiff(input.state.snapshot);
  const synthesized = output
    ? decodeSynthesis(
        output.text,
        collected.rawFindings,
        collected.reviewers,
        diff,
        input.synthesisProtocol,
      )
    : undefined;
  if (output && !synthesized) collected.malformedNodes.push(SynthesisNode.nodeId);
  const fallbackReason = output
    ? "Synthesis output was malformed or did not account for every admitted raw finding exactly once."
    : "Synthesis output was unavailable.";
  const result = synthesized ?? fallbackConsolidation(collected.rawFindings, fallbackReason);
  return {
    output,
    result: synthesized ? result : validateFindingAnchors(result, diff),
    fallback: !synthesized,
  };
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
function reviewCoverage(
  collected: CollectedOutputs,
  failedNodes: readonly string[],
  synthesisFallback: boolean,
): NonNullable<ReviewResult["coverage"]> {
  const failed = reviewerRolesForNodes([
    ...new Set([...failedNodes, ...collected.failedReviewerNodes]),
  ]);
  const degraded =
    failedNodes.length > 0 ||
    failed.length > 0 ||
    collected.malformedNodes.length > 0 ||
    (collected.evidenceCoverage?.omissions.length ?? 0) > 0 ||
    !collected.plan ||
    synthesisFallback;
  return {
    status: degraded ? "degraded" : "complete",
    succeeded: collected.reviewers.map((output) => output.role).sort(),
    failed,
    malformed: reviewerRolesForNodes(collected.malformedNodes),
  };
}
function finalizedReviewState(
  input: FinalizeReviewInput,
  collected: CollectedOutputs,
  failedNodes: string[],
  synthesis: Awaited<ReturnType<typeof resolveSynthesis>>,
): ReviewState {
  const coverage = reviewCoverage(collected, failedNodes, synthesis.fallback);
  synthesis.result.coverage = coverage;
  return {
    ...input.state,
    metrics: reviewMetrics({
      state: input.state,
      startedAt: input.startedAt,
      references: collected.rawResultReferences,
      succeeded: coverage.succeeded.length,
      failed: reviewerRolesForNodes(failedNodes).length,
      malformed: coverage.malformed.length,
      blocked: reviewerRolesForNodes(blockedNodeIds(input.reconstruction)).length,
      result: synthesis.result,
      evidence: collected.evidenceCoverage,
      reviewerAttempts: reviewerAttemptCount(input.reconstruction),
      usage: input.service.usage?.(input.runId),
    }),
    ...(collected.plan ? { plan: collected.plan } : {}),
    result: synthesis.result,
    selectedFindingIds: selectedFindings({
      ...input.state,
      result: synthesis.result,
      selectedFindingIds: synthesis.result.findings.flatMap((finding) =>
        finding.selected && finding.id ? [finding.id] : [],
      ),
    }).map((finding) => finding.id!),
    dag: {
      runId: input.runId,
      startedAt: input.state.dag?.startedAt,
      submitted: input.state.dag?.submitted,
      ...(input.state.dag?.synthesisProtocol === undefined
        ? {}
        : { synthesisProtocol: input.state.dag.synthesisProtocol }),
      status: outcomeStatus(input.reconstruction, coverage.status === "degraded"),
      rawResultReferences: collected.rawResultReferences,
      ...(collected.readingPlanReference
        ? { readingPlanReference: collected.readingPlanReference }
        : {}),
      evidenceReferences: [...collected.evidenceReferences],
      ...evidenceCoverageState(collected.evidenceCoverage),
      ...(synthesis.output ? { synthesisReference: synthesis.output.reference } : {}),
      failedNodes,
      blockedNodes: blockedNodeIds(input.reconstruction),
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
    input.admission,
  );
  const failedNodes = failedNodeIds(input.reconstruction);
  if (collected.reviewers.length === 0)
    return preserveAllFailedOutputs(
      input.state,
      input.runId,
      input.reconstruction,
      collected,
      failedNodes,
      input.startedAt,
      input.service.usage?.(input.runId),
    );
  const synthesis = await resolveSynthesis(input, collected);
  return finalizedReviewState(input, collected, failedNodes, synthesis);
}
function failedRunState(
  state: ReviewState,
  runId: string,
  cause: unknown,
  startedAt: number,
  service: DagRuntimeService.ActiveDagRuntimeService,
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
        failed: reviewerRolesForNodes(state.dag?.failedNodes ?? []).length,
        malformed: reviewerRolesForNodes(state.dag?.malformedNodes ?? []).length,
        blocked: reviewerRolesForNodes(state.dag?.blockedNodes ?? []).length,
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
  readonly service: DagRuntimeService.ActiveDagRuntimeService;
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
    synthesisProtocol:
      options.state.dag.synthesisProtocol === undefined
        ? "legacy"
        : options.state.dag.synthesisProtocol === 2
          ? 2
          : "unsupported",
  });
}

export async function runReviewDag(options: {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
  readonly signal?: AbortSignal;
  readonly service: DagRuntimeService.ActiveDagRuntimeService;
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
  const tools = DagTools.createReviewDagTools({
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
        synthesisProtocol: 2,
        rawResultReferences: [],
      },
    };
    options.save(state);
    await awaitSubmittedGraph(
      options.service,
      graph,
      { workspaceRoot: state.snapshot.worktree, customTools: tools.customTools },
      state.snapshot.id,
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
      admission: tools.admission(options.signal),
      synthesisProtocol: 2,
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
  }
}
