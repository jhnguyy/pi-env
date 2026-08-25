import { Effect } from "effect";
import {
  DagNodeStatus,
  materializeDagTextArtifact,
  type DagSessionReconstruction,
  type DagTextArtifactReference,
} from "../../../src/dag/index.js";
import { ReviewerNodes } from "./review-topology";
import { type ReviewerOutput, validateReviewerOutputShape } from "./schema";

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
      text: item.text,
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

  while (
    admitted.length > 0 &&
    Buffer.byteLength(
      serializedReviewerDossierContext({ admitted, raw, failed, malformed }),
      "utf8",
    ) > MaxReviewerDossierBytes
  ) {
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
    raw: Object.freeze(raw),
    failed: Object.freeze(failed),
    malformed: Object.freeze(malformed),
  });
}
