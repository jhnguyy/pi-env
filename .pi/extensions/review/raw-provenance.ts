import { createHash } from "node:crypto";
import * as Fs from "node:fs/promises";
import path from "node:path";
import { Data, Effect } from "effect";
import { materializeDagTextArtifact } from "../../../src/dag/index.js";
import {
  type AdmittedRawFinding,
  type RawFindingArtifactReference,
  type RawFindingRecord,
  validateAdmittedRawFindingShape,
  validateRawFindingRecordShape,
} from "./schema";

export const MaxRawFindingArtifactBytes = 262_144;
const RawFindingDirectory = "raw-provenance-v2";
const RawFindingProducer = "pr-review-raw-provenance-v2";

export class RawFindingArtifactError extends Data.TaggedError("RawFindingArtifactError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function failure(message: string, cause?: unknown): RawFindingArtifactError {
  return new RawFindingArtifactError({ message, cause });
}

function errorCode(cause: unknown): unknown {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? (cause as { readonly code?: unknown }).code
    : undefined;
}

function writeExclusive(filePath: string, bytes: Buffer): Promise<"created" | "exists"> {
  return Fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 }).then(
    () => "created" as const,
    (cause: unknown) =>
      errorCode(cause) === "EEXIST" ? ("exists" as const) : Promise.reject(cause),
  );
}

function isCanonicalChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function prepareArtifactDirectory(root: string): Effect.Effect<string, RawFindingArtifactError> {
  return Effect.tryPromise({
    try: async () => {
      const canonicalRoot = await Fs.realpath(root);
      const directory = path.join(canonicalRoot, RawFindingDirectory);
      await Fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await Fs.lstat(directory);
      const canonicalDirectory = await Fs.realpath(directory);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        !isCanonicalChild(canonicalRoot, canonicalDirectory)
      )
        throw failure("Raw finding artifact directory is not a confined real directory.");
      return canonicalDirectory;
    },
    catch: (cause) =>
      cause instanceof RawFindingArtifactError
        ? cause
        : failure("Could not prepare raw finding artifact storage.", cause),
  });
}

function rejectSymlinkComponents(
  root: string,
  relativePath: string,
): Effect.Effect<void, RawFindingArtifactError> {
  return Effect.tryPromise({
    try: async () => {
      const canonicalRoot = await Fs.realpath(root);
      let current = canonicalRoot;
      for (const component of relativePath.split("/")) {
        current = path.join(current, component);
        if ((await Fs.lstat(current)).isSymbolicLink())
          throw failure("Raw finding artifact references must not traverse symlinks.");
      }
    },
    catch: (cause) =>
      cause instanceof RawFindingArtifactError
        ? cause
        : failure("Could not verify raw finding artifact symlink policy.", cause),
  });
}

function artifactReference(
  runId: string,
  rawFindingId: string,
  bytes: Buffer,
): RawFindingArtifactReference {
  return Object.freeze({
    v: 1,
    path: `${RawFindingDirectory}/${rawFindingId}.json`,
    bytes: bytes.length,
    digestAlgorithm: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
    mediaType: "text/plain",
    encoding: "utf-8",
    runId,
    producerNodeId: RawFindingProducer,
    outputName: rawFindingId,
  });
}

/** Materializes one requested raw finding after identity, containment, symlink, size, and digest checks. */
export function readRawFindingArtifact(
  artifactRoot: string,
  runId: string,
  recordValue: unknown,
): Effect.Effect<AdmittedRawFinding, RawFindingArtifactError> {
  return Effect.gen(function* () {
    if (!validateRawFindingRecordShape(recordValue))
      return yield* failure("Raw finding provenance record is malformed.");
    const record = recordValue;
    if (record.artifact.runId !== runId)
      return yield* failure(
        "Raw finding artifact run identity does not match the requested review.",
      );
    if (record.artifact.bytes > MaxRawFindingArtifactBytes)
      return yield* failure("Raw finding artifact exceeds the public byte ceiling.");
    yield* rejectSymlinkComponents(artifactRoot, record.artifact.path);
    const materialized = yield* materializeDagTextArtifact(
      artifactRoot,
      record.artifact,
      {
        runId,
        producerNodeId: RawFindingProducer,
        outputName: record.id,
      },
      MaxRawFindingArtifactBytes,
    ).pipe(Effect.mapError((cause) => failure("Raw finding artifact verification failed.", cause)));
    const decoded = yield* Effect.try({
      try: () => JSON.parse(materialized.text) as unknown,
      catch: (cause) => failure("Raw finding artifact is not valid JSON.", cause),
    });
    if (
      !validateAdmittedRawFindingShape(decoded) ||
      decoded.id !== record.id ||
      decoded.role !== record.role ||
      decoded.evidenceDigest !== record.evidenceDigest
    )
      return yield* failure("Raw finding artifact content does not match its provenance record.");
    return Object.freeze({ ...decoded, finding: Object.freeze({ ...decoded.finding }) });
  });
}

/** Writes immutable, review-owned raw finding artifacts and returns payload-free state records. */
export function persistRawFindingArtifacts(
  artifactRoot: string,
  runId: string,
  rawFindings: readonly AdmittedRawFinding[],
): Effect.Effect<readonly RawFindingRecord[], RawFindingArtifactError> {
  return Effect.gen(function* () {
    const directory = yield* prepareArtifactDirectory(artifactRoot);
    const records: RawFindingRecord[] = [];
    const ids = new Set<string>();
    for (const raw of rawFindings) {
      if (!validateAdmittedRawFindingShape(raw))
        return yield* failure("Admitted raw finding is malformed.");
      if (ids.has(raw.id)) return yield* failure("Admitted raw finding IDs must be unique.");
      ids.add(raw.id);
      const bytes = Buffer.from(JSON.stringify(raw), "utf8");
      if (bytes.length > MaxRawFindingArtifactBytes)
        return yield* failure("Raw finding artifact exceeds the public byte ceiling.");
      const reference = artifactReference(runId, raw.id, bytes);
      const filePath = path.join(directory, `${raw.id}.json`);
      yield* Effect.tryPromise({
        try: () => writeExclusive(filePath, bytes),
        catch: (cause) => failure("Could not persist raw finding artifact.", cause),
      });
      const record = Object.freeze({
        id: raw.id,
        role: raw.role,
        evidenceDigest: raw.evidenceDigest,
        artifact: reference,
      });
      yield* readRawFindingArtifact(artifactRoot, runId, record);
      records.push(record);
    }
    return Object.freeze(records);
  });
}
