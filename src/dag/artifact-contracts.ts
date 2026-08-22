import { Data } from "effect";
import * as ArtifactPaths from "./artifact-paths.js";

export const DagTextArtifactReferenceVersion = 1 as const;
export const DagTextArtifactDigestAlgorithm = "sha256" as const;
export const DagTextArtifactMediaType = "text/plain" as const;
export const DagTextArtifactEncoding = "utf-8" as const;

export interface DagTextArtifactReference {
  readonly v: typeof DagTextArtifactReferenceVersion;
  readonly path: string;
  readonly bytes: number;
  readonly digestAlgorithm: typeof DagTextArtifactDigestAlgorithm;
  readonly digest: string;
  readonly mediaType: typeof DagTextArtifactMediaType;
  readonly encoding: typeof DagTextArtifactEncoding;
  readonly runId: string;
  readonly producerNodeId: string;
  readonly outputName: string;
}

export interface DagArtifactLimits {
  readonly maxOutputsPerNode: number;
  readonly maxArtifactBytes: number;
  readonly maxBytesPerNode: number;
  readonly maxContextBytes: number;
}

export const DagDefaultArtifactLimits = Object.freeze({
  maxOutputsPerNode: 32,
  maxArtifactBytes: 262_144,
  maxBytesPerNode: 1_048_576,
  maxContextBytes: 2_097_152,
} as const satisfies DagArtifactLimits);

export interface DagMaterializedTextArtifact {
  readonly outputName: string;
  readonly producerNodeId: string;
  readonly reference: DagTextArtifactReference;
  readonly text: string;
}

export interface DagMaterializedTextContext {
  readonly outputs: readonly DagMaterializedTextArtifact[];
  readonly bytes: number;
}

export const DagArtifactFailureTag = {
  MalformedReference: "malformed-reference",
  PathRejected: "path-rejected",
  OutputLimitExceeded: "output-limit-exceeded",
  ArtifactLimitExceeded: "artifact-limit-exceeded",
  NodeLimitExceeded: "node-limit-exceeded",
  ContextLimitExceeded: "context-limit-exceeded",
  Filesystem: "filesystem",
  MissingFile: "missing-file",
  NotFile: "not-file",
  Containment: "containment",
  Changed: "changed",
  SizeMismatch: "size-mismatch",
  DigestMismatch: "digest-mismatch",
  UnsupportedMedia: "unsupported-media",
  Utf8: "utf8",
  IdentityMismatch: "identity-mismatch",
  MissingOutput: "missing-output",
  AmbiguousOutput: "ambiguous-output",
} as const;
export type DagArtifactFailureTag = (typeof DagArtifactFailureTag)[keyof typeof DagArtifactFailureTag];

export class DagArtifactMalformedReference extends Data.TaggedError(DagArtifactFailureTag.MalformedReference)<{
  readonly message: string;
  readonly reference?: unknown;
}> {}
export class DagArtifactPathRejected extends Data.TaggedError(DagArtifactFailureTag.PathRejected)<{
  readonly path: string;
  readonly message: string;
}> {}
export class DagArtifactOutputLimitExceeded extends Data.TaggedError(DagArtifactFailureTag.OutputLimitExceeded)<{
  readonly actual: number;
  readonly max: number;
}> {}
export class DagArtifactLimitExceeded extends Data.TaggedError(DagArtifactFailureTag.ArtifactLimitExceeded)<{
  readonly path: string;
  readonly actual: number;
  readonly max: number;
}> {}
export class DagArtifactNodeLimitExceeded extends Data.TaggedError(DagArtifactFailureTag.NodeLimitExceeded)<{
  readonly producerNodeId: string;
  readonly actual: number;
  readonly max: number;
}> {}
export class DagArtifactContextLimitExceeded extends Data.TaggedError(DagArtifactFailureTag.ContextLimitExceeded)<{
  readonly actual: number;
  readonly max: number;
}> {}
export class DagArtifactFilesystem extends Data.TaggedError(DagArtifactFailureTag.Filesystem)<{
  readonly operation: string;
  readonly path: string;
  readonly cause: unknown;
}> {}
export class DagArtifactMissingFile extends Data.TaggedError(DagArtifactFailureTag.MissingFile)<{ readonly path: string; readonly cause: unknown }> {}
export class DagArtifactNotFile extends Data.TaggedError(DagArtifactFailureTag.NotFile)<{ readonly path: string }> {}
export class DagArtifactContainment extends Data.TaggedError(DagArtifactFailureTag.Containment)<{ readonly path: string }> {}
export class DagArtifactChanged extends Data.TaggedError(DagArtifactFailureTag.Changed)<{ readonly path: string }> {}
export class DagArtifactSizeMismatch extends Data.TaggedError(DagArtifactFailureTag.SizeMismatch)<{
  readonly path: string;
  readonly expected: number;
  readonly actual: number;
}> {}
export class DagArtifactDigestMismatch extends Data.TaggedError(DagArtifactFailureTag.DigestMismatch)<{ readonly path: string }> {}
export class DagArtifactUnsupportedMedia extends Data.TaggedError(DagArtifactFailureTag.UnsupportedMedia)<{ readonly path: string }> {}
export class DagArtifactUtf8 extends Data.TaggedError(DagArtifactFailureTag.Utf8)<{ readonly path: string; readonly cause: unknown }> {}
export class DagArtifactIdentityMismatch extends Data.TaggedError(DagArtifactFailureTag.IdentityMismatch)<{
  readonly expectedRunId: string;
  readonly expectedProducerNodeId: string;
  readonly expectedOutputName: string;
  readonly reference: unknown;
}> {}
export class DagArtifactMissingOutput extends Data.TaggedError(DagArtifactFailureTag.MissingOutput)<{ readonly outputName: string }> {}
export class DagArtifactAmbiguousOutput extends Data.TaggedError(DagArtifactFailureTag.AmbiguousOutput)<{
  readonly outputName: string;
  readonly producerNodeIds: readonly string[];
}> {}

export type DagArtifactFailure =
  | DagArtifactMalformedReference
  | DagArtifactPathRejected
  | DagArtifactOutputLimitExceeded
  | DagArtifactLimitExceeded
  | DagArtifactNodeLimitExceeded
  | DagArtifactContextLimitExceeded
  | DagArtifactFilesystem
  | DagArtifactMissingFile
  | DagArtifactNotFile
  | DagArtifactContainment
  | DagArtifactChanged
  | DagArtifactSizeMismatch
  | DagArtifactDigestMismatch
  | DagArtifactUnsupportedMedia
  | DagArtifactUtf8
  | DagArtifactIdentityMismatch
  | DagArtifactMissingOutput
  | DagArtifactAmbiguousOutput;

const referenceKeys = Object.freeze([
  "v",
  "path",
  "bytes",
  "digestAlgorithm",
  "digest",
  "mediaType",
  "encoding",
  "runId",
  "producerNodeId",
  "outputName",
] as const);
const digestPattern = /^[0-9a-f]{64}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactReferenceKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...referenceKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function requireReferenceString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireReferenceBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function digestValue(value: unknown): string | undefined {
  return typeof value === "string" && digestPattern.test(value) ? value : undefined;
}

function referenceVersionAndDigestAreValid(value: Record<string, unknown>): boolean {
  return value.v === DagTextArtifactReferenceVersion && value.digestAlgorithm === DagTextArtifactDigestAlgorithm;
}

function referenceMediaIsSupported(value: Record<string, unknown>): boolean {
  return value.mediaType === DagTextArtifactMediaType && value.encoding === DagTextArtifactEncoding;
}

interface ParsedReferenceValues {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
  readonly runId: string;
  readonly producerNodeId: string;
  readonly outputName: string;
}
function parsedReferenceValues(value: Record<string, unknown>): ParsedReferenceValues | undefined {
  const path = requireReferenceString(value.path);
  const bytes = requireReferenceBytes(value.bytes);
  const digest = digestValue(value.digest);
  const runId = requireReferenceString(value.runId);
  const producerNodeId = requireReferenceString(value.producerNodeId);
  const outputName = requireReferenceString(value.outputName);
  if (path === undefined || bytes === undefined || digest === undefined || runId === undefined ||
    producerNodeId === undefined || outputName === undefined) return undefined;
  return { path, bytes, digest, runId, producerNodeId, outputName };
}

export function validateDagArtifactRelativePath(relativePath: string): string {
  const result = ArtifactPaths.parseDagArtifactRelativePath(relativePath);
  if (!result.ok) throw new DagArtifactPathRejected({ path: relativePath, message: result.message });
  return result.path;
}
export function parseDagTextArtifactReference(value: unknown): DagTextArtifactReference {
  if (!isPlainRecord(value)) throw new DagArtifactMalformedReference({ message: "reference must be a record", reference: value });
  if (!hasExactReferenceKeys(value))
    throw new DagArtifactMalformedReference({ message: "reference fields must exactly match v1 contract", reference: value });
  const parsed = parsedReferenceValues(value);
  if (!parsed || !referenceVersionAndDigestAreValid(value))
    throw new DagArtifactMalformedReference({ message: "reference contains malformed v1 values", reference: value });
  const relativePath = validateDagArtifactRelativePath(parsed.path);
  if (relativePath !== parsed.path)
    throw new DagArtifactPathRejected({ path: parsed.path, message: "path must use its normalized form" });
  if (!referenceMediaIsSupported(value)) throw new DagArtifactUnsupportedMedia({ path: relativePath });
  return Object.freeze({
    v: DagTextArtifactReferenceVersion,
    path: relativePath,
    bytes: parsed.bytes,
    digestAlgorithm: DagTextArtifactDigestAlgorithm,
    digest: parsed.digest,
    mediaType: DagTextArtifactMediaType,
    encoding: DagTextArtifactEncoding,
    runId: parsed.runId,
    producerNodeId: parsed.producerNodeId,
    outputName: parsed.outputName,
  } as DagTextArtifactReference);
}

export function assertDagTextArtifactIdentity(
  reference: DagTextArtifactReference,
  runId: string,
  producerNodeId: string,
  outputName: string,
): void {
  if (reference.runId !== runId || reference.producerNodeId !== producerNodeId || reference.outputName !== outputName)
    throw new DagArtifactIdentityMismatch({
      expectedRunId: runId,
      expectedProducerNodeId: producerNodeId,
      expectedOutputName: outputName,
      reference,
    });
}
