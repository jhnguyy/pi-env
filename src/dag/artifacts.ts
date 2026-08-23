import { Effect } from "effect";
import * as ArtifactContracts from "./artifact-contracts.js";
import * as ArtifactFs from "./artifact-fs.js";
import * as DagContracts from "./contracts.js";
import type * as DagKernel from "./kernel.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type {
  DagArtifactFailure,
  DagArtifactLimits,
  DagMaterializedTextArtifact,
  DagMaterializedTextContext,
  DagTextArtifactReference,
} from "./artifact-contracts.js";
export {
  DagArtifactAmbiguousOutput,
  DagArtifactChanged,
  DagArtifactContainment,
  DagArtifactContextLimitExceeded,
  DagArtifactDigestMismatch,
  DagArtifactFailureTag,
  DagArtifactFilesystem,
  DagArtifactIdentityMismatch,
  DagArtifactLimitExceeded,
  DagArtifactMalformedReference,
  DagArtifactMissingFile,
  DagArtifactMissingOutput,
  DagArtifactNodeLimitExceeded,
  DagArtifactNotFile,
  DagArtifactOutputLimitExceeded,
  DagArtifactPathRejected,
  DagArtifactSizeMismatch,
  DagArtifactUnsupportedMedia,
  DagArtifactUtf8,
  DagDefaultArtifactLimits,
  DagTextArtifactDigestAlgorithm,
  DagTextArtifactEncoding,
  DagTextArtifactMediaType,
  DagTextArtifactReferenceVersion,
  parseDagTextArtifactReference,
} from "./artifact-contracts.js";

export function admitDagTextArtifacts(
  root: string,
  runId: string,
  producerNodeId: string,
  outputs: Readonly<Record<string, string>>,
): Effect.Effect<DagContracts.DagNamedOutputs<ArtifactContracts.DagTextArtifactReference>, ArtifactContracts.DagArtifactFailure> {
  return Effect.gen(function* () {
    const entries = Object.entries(outputs);
    if (entries.length > ArtifactContracts.DagDefaultArtifactLimits.maxOutputsPerNode)
      return yield* new ArtifactContracts.DagArtifactOutputLimitExceeded({
        actual: entries.length,
        max: ArtifactContracts.DagDefaultArtifactLimits.maxOutputsPerNode,
      });
    if (runId.length === 0 || producerNodeId.length === 0 || entries.some(([outputName, relativePath]) =>
      outputName.length === 0 || typeof relativePath !== "string"))
      return yield* new ArtifactContracts.DagArtifactMalformedReference({
        message: "run id, producer node id, output names, and paths must be non-empty strings",
      });
    let nodeBytes = 0;
    const admitted: Array<readonly [string, ArtifactContracts.DagTextArtifactReference]> = [];
    for (const [outputName, relativePath] of entries.sort(([left], [right]) => compareText(left, right))) {
      const reference = yield* ArtifactFs.admitDagArtifactFile(root, runId, producerNodeId, outputName, relativePath, nodeBytes);
      nodeBytes += reference.bytes;
      admitted.push([outputName, reference]);
    }
    return Object.freeze(Object.fromEntries(admitted));
  });
}

interface SelectedReference {
  readonly outputName: string;
  readonly producerNodeId: string;
  readonly reference: ArtifactContracts.DagTextArtifactReference;
}

export function selectDagTextArtifactReferences(
  runId: string,
  targetNode: DagContracts.DagNode<unknown>,
  state: DagKernel.DagRunState<unknown, unknown>,
  requestedOutputNames: readonly string[],
): readonly SelectedReference[] {
  const successfulByName = new Map<string, SelectedReference[]>();
  const requestedNames = new Set(requestedOutputNames);
  const dependencyIds = new Set(targetNode.dependencies.map((dependency) => dependency.nodeId));
  for (const node of state.nodes) {
    if (!dependencyIds.has(node.nodeId) || node.status !== DagContracts.DagNodeStatus.Succeeded) continue;
    const outputEntries = Object.entries(node.outputs);
    if (outputEntries.length > ArtifactContracts.DagDefaultArtifactLimits.maxOutputsPerNode)
      throw new ArtifactContracts.DagArtifactOutputLimitExceeded({
        actual: outputEntries.length,
        max: ArtifactContracts.DagDefaultArtifactLimits.maxOutputsPerNode,
      });
    for (const [outputName, rawReference] of outputEntries) {
      if (!requestedNames.has(outputName)) continue;
      const reference = ArtifactContracts.parseDagTextArtifactReference(rawReference);
      ArtifactContracts.assertDagTextArtifactIdentity(reference, runId, node.nodeId, outputName);
      const current = successfulByName.get(outputName) ?? [];
      current.push(Object.freeze({ outputName, producerNodeId: node.nodeId, reference }));
      successfulByName.set(outputName, current);
    }
  }
  const selected: SelectedReference[] = [];
  const requested = new Set<string>();
  for (const outputName of requestedOutputNames) {
    const candidates = successfulByName.get(outputName) ?? [];
    if (candidates.length === 0) throw new ArtifactContracts.DagArtifactMissingOutput({ outputName });
    if (candidates.length > 1 || requested.has(outputName))
      throw new ArtifactContracts.DagArtifactAmbiguousOutput({
        outputName,
        producerNodeIds: Object.freeze(candidates.map((candidate) => candidate.producerNodeId).sort()),
      });
    requested.add(outputName);
    selected.push(candidates[0]);
  }
  return Object.freeze(selected.sort((left, right) =>
    compareText(left.producerNodeId, right.producerNodeId) || compareText(left.outputName, right.outputName)));
}

export function materializeDagTextContext(
  root: string,
  runId: string,
  targetNode: DagContracts.DagNode<unknown>,
  state: DagKernel.DagRunState<unknown, unknown>,
  requestedOutputNames: readonly string[],
): Effect.Effect<ArtifactContracts.DagMaterializedTextContext, ArtifactContracts.DagArtifactFailure> {
  return Effect.gen(function* () {
    const selected = yield* Effect.try({
      try: () => selectDagTextArtifactReferences(runId, targetNode, state, requestedOutputNames),
      catch: (cause) => cause as ArtifactContracts.DagArtifactFailure,
    });
    const byProducer = new Map<string, number>();
    let contextBytes = 0;
    for (const item of selected) {
      const producerBytes = byProducer.get(item.producerNodeId) ?? 0;
      const projectedProducerBytes = producerBytes + item.reference.bytes;
      if (projectedProducerBytes > ArtifactContracts.DagDefaultArtifactLimits.maxBytesPerNode)
        return yield* new ArtifactContracts.DagArtifactNodeLimitExceeded({
          producerNodeId: item.producerNodeId,
          actual: projectedProducerBytes,
          max: ArtifactContracts.DagDefaultArtifactLimits.maxBytesPerNode,
        });
      byProducer.set(item.producerNodeId, projectedProducerBytes);
      const projectedContextBytes = contextBytes + item.reference.bytes;
      if (projectedContextBytes > ArtifactContracts.DagDefaultArtifactLimits.maxContextBytes)
        return yield* new ArtifactContracts.DagArtifactContextLimitExceeded({
          actual: projectedContextBytes,
          max: ArtifactContracts.DagDefaultArtifactLimits.maxContextBytes,
        });
      contextBytes = projectedContextBytes;
    }

    byProducer.clear();
    contextBytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const outputs: ArtifactContracts.DagMaterializedTextArtifact[] = [];
    for (const item of selected) {
      const producerBytes = byProducer.get(item.producerNodeId) ?? 0;
      const bytes = yield* ArtifactFs.readDagArtifactBytes(root, item.reference, ArtifactContracts.DagDefaultArtifactLimits.maxContextBytes - contextBytes);
      byProducer.set(item.producerNodeId, producerBytes + bytes.length);
      contextBytes += bytes.length;
      const text = yield* Effect.try({
        try: () => decoder.decode(bytes),
        catch: (cause) => new ArtifactContracts.DagArtifactUtf8({ path: item.reference.path, cause }),
      });
      outputs.push(Object.freeze({
        outputName: item.outputName,
        producerNodeId: item.producerNodeId,
        reference: item.reference,
        text,
      }));
    }
    return Object.freeze({ outputs: Object.freeze(outputs), bytes: contextBytes });
  });
}
