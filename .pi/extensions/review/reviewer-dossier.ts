import { Effect } from "effect";
import {
  DagNodeStatus,
  materializeDagTextArtifact,
  type DagSessionReconstruction,
  type DagTextArtifactReference,
} from "../../../src/dag/index.js";
import { ReviewerNodes } from "./review-topology";
import {
  type AdmittedRawFinding,
  type RawFindingRecord,
  type ReviewerOutput,
  validateReviewerOutputShape,
} from "./schema";
import { buildRawFindingRecords } from "./synthesis-provenance";

export const MaxReviewerDossierBytes = 1_750_000;

type ReviewerTopologyNode = (typeof ReviewerNodes)[number];

export interface VerifiedReviewerArtifact {
  readonly nodeId: string;
  readonly outputName: string;
  readonly reference: DagTextArtifactReference;
  readonly text: string;
}

export interface AdmittedReviewerArtifact extends VerifiedReviewerArtifact {
  readonly reviewer: ReviewerOutput;
}

/** A single, fail-closed admission pass over all reviewer nodes. */
export interface ReviewerDossier {
  readonly admitted: readonly AdmittedReviewerArtifact[];
  readonly rawFindings: readonly AdmittedRawFinding[];
  /** References whose bytes and DAG identity were verified, including malformed results. */
  readonly raw: readonly VerifiedReviewerArtifact[];
  readonly failed: readonly string[];
  readonly malformed: readonly string[];
}

export function reviewerDossierContext(dossier: ReviewerDossier) {
  return {
    succeeded: dossier.admitted.map((item) => ({
      nodeId: item.nodeId,
      outputName: item.outputName,
      reference: item.reference,
      role: item.reviewer.role,
      evidenceDigest: item.reviewer.evidenceDigest,
      verdict: item.reviewer.verdict,
      rawFindings: dossier.rawFindings.filter((raw) => raw.role === item.reviewer.role),
    })),
    verifiedReferences: dossier.raw.map((item) => ({
      nodeId: item.nodeId,
      outputName: item.outputName,
      reference: item.reference,
    })),
    failed: dossier.failed,
    malformed: dossier.malformed,
  };
}

function serializedReviewerDossierContext(dossier: ReviewerDossier): string {
  return JSON.stringify(reviewerDossierContext(dossier));
}

export function serializeReviewerDossierContext(dossier: ReviewerDossier): string {
  const text = serializedReviewerDossierContext(dossier);
  if (Buffer.byteLength(text, "utf8") > MaxReviewerDossierBytes)
    throw new Error("Reviewer result context exceeds the absolute byte limit.");
  return text;
}

export async function readVerifiedReviewArtifact(
  artifactRoot: string,
  referenceValue: unknown,
  expected: {
    readonly runId: string;
    readonly producerNodeId: string;
    readonly outputName: string;
  },
): Promise<{ reference: DagTextArtifactReference; text: string }> {
  return Effect.runPromise(
    materializeDagTextArtifact(artifactRoot, referenceValue, expected, MaxReviewerDossierBytes),
  );
}

function reviewerTopologyOrder(
  reconstruction: DagSessionReconstruction,
): readonly ReviewerTopologyNode[] {
  const representedNodeIds = reconstruction.graph
    ? new Set(reconstruction.graph.nodes.map((node) => node.id))
    : new Set(reconstruction.state.nodes.map((node) => node.nodeId));
  return ReviewerNodes.filter((node) => representedNodeIds.has(node.nodeId));
}

function decodeReviewer(
  text: string,
  expectedRole: ReviewerOutput["role"],
  expectedEvidenceDigest: string | undefined,
): ReviewerOutput | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return validateReviewerOutputShape(value) &&
      value.role === expectedRole &&
      value.evidenceDigest === expectedEvidenceDigest
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Lazily reads one occurrence from its already-admitted reviewer DAG artifact. */
export async function readVerifiedRawFinding(
  artifactRoot: string,
  runId: string,
  value: RawFindingRecord,
): Promise<Omit<AdmittedRawFinding, "artifact">> {
  const topology = ReviewerNodes.find((node) => node.role === value?.role);
  if (!topology || !Number.isSafeInteger(value.index) || value.index < 0)
    throw new Error("Raw finding provenance is malformed.");
  const materialized = await readVerifiedReviewArtifact(artifactRoot, value.artifact, {
    runId,
    producerNodeId: topology.nodeId,
    outputName: topology.outputName,
  });
  const reviewer = decodeReviewer(materialized.text, value.role, value.evidenceDigest);
  if (!reviewer || value.index >= reviewer.findings.length)
    throw new Error("Raw finding provenance does not match the admitted reviewer output.");
  const admitted = buildRawFindingRecords([{ reviewer, reference: materialized.reference }]);
  const finding = admitted.find((candidate) => candidate.index === value.index);
  if (!finding || finding.id !== value.id)
    throw new Error("Raw finding identity does not match its reviewer occurrence.");
  const { artifact: _artifact, ...inspected } = finding;
  return inspected;
}

export async function admitReviewerDossier(options: {
  readonly artifactRoot: string;
  readonly reconstruction: DagSessionReconstruction;
  readonly expectedEvidenceDigest: string | undefined;
}): Promise<ReviewerDossier> {
  const admitted: AdmittedReviewerArtifact[] = [];
  const raw: VerifiedReviewerArtifact[] = [];
  const failed: string[] = [];
  const malformed: string[] = [];
  const stateById = new Map(options.reconstruction.state.nodes.map((node) => [node.nodeId, node]));

  for (const topologyNode of reviewerTopologyOrder(options.reconstruction)) {
    const state = stateById.get(topologyNode.nodeId);
    if (!state || state.status !== DagNodeStatus.Succeeded) {
      failed.push(topologyNode.nodeId);
      continue;
    }

    const outputs = Object.entries(state.outputs).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const verified: VerifiedReviewerArtifact[] = [];
    for (const [outputName, referenceValue] of outputs) {
      try {
        const artifact = await readVerifiedReviewArtifact(options.artifactRoot, referenceValue, {
          runId: options.reconstruction.graph?.runId ?? "",
          producerNodeId: topologyNode.nodeId,
          outputName,
        });
        const item = { nodeId: topologyNode.nodeId, outputName, ...artifact };
        verified.push(item);
        raw.push(item);
      } catch {
        // Artifact identity, digest, size, containment, and file failures are malformed output.
      }
    }

    const exact =
      outputs.length === 1 && outputs[0][0] === topologyNode.outputName && verified.length === 1;
    const reviewer = exact
      ? decodeReviewer(verified[0].text, topologyNode.role, options.expectedEvidenceDigest)
      : undefined;
    if (!reviewer) {
      malformed.push(topologyNode.nodeId);
      continue;
    }
    admitted.push({ ...verified[0], reviewer });
  }

  while (admitted.length > 0) {
    const candidate = {
      admitted,
      rawFindings: buildRawFindingRecords(admitted),
      raw,
      failed,
      malformed,
    };
    if (
      Buffer.byteLength(serializedReviewerDossierContext(candidate), "utf8") <=
      MaxReviewerDossierBytes
    )
      break;
    const removed = admitted.pop();
    if (removed) malformed.push(removed.nodeId);
  }
  const topologyIndex = new Map<string, number>(
    ReviewerNodes.map((node, index) => [node.nodeId, index]),
  );
  malformed.sort(
    (left, right) =>
      (topologyIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (topologyIndex.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
  return Object.freeze({
    admitted: Object.freeze(admitted),
    rawFindings: buildRawFindingRecords(admitted),
    raw: Object.freeze(raw),
    failed: Object.freeze(failed),
    malformed: Object.freeze(malformed),
  });
}
