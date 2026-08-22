import { createHash } from "node:crypto";
import { constants as FsConstants } from "node:fs";
import * as Fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import * as ArtifactContracts from "./artifact-contracts.js";
import * as ArtifactPaths from "./artifact-paths.js";

type FileStat = Awaited<ReturnType<typeof Fs.stat>>;
type FileHandle = Awaited<ReturnType<typeof Fs.open>>;

interface CanonicalFile {
  readonly root: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly canonicalPath: string;
  readonly stat: FileStat;
}

function filesystemFailure(operation: string, filePath: string, cause: unknown): ArtifactContracts.DagArtifactFailure {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? (cause as { readonly code?: unknown }).code : undefined;
  if (code === "ENOENT") return new ArtifactContracts.DagArtifactMissingFile({ path: filePath, cause });
  return new ArtifactContracts.DagArtifactFilesystem({ operation, path: filePath, cause });
}

function statSize(stat: FileStat): number {
  return typeof stat.size === "bigint" ? Number(stat.size) : stat.size;
}

function statIdentityEqual(left: FileStat, right: FileStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && statSize(left) === statSize(right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

const noFollow = typeof FsConstants.O_NOFOLLOW === "number" ? FsConstants.O_NOFOLLOW : 0;

function resolveCanonicalFile(root: string, relativePath: string): Effect.Effect<CanonicalFile, ArtifactContracts.DagArtifactFailure> {
  return Effect.gen(function* () {
    const normalized = yield* Effect.try({
      try: () => ArtifactContracts.validateDagArtifactRelativePath(relativePath),
      catch: (cause) => cause as ArtifactContracts.DagArtifactFailure,
    });
    const canonicalRoot = yield* Effect.tryPromise({
      try: () => Fs.realpath(root),
      catch: (cause) => filesystemFailure("realpath", root, cause),
    });
    const absolutePath = path.resolve(canonicalRoot, normalized);
    const canonicalPath = yield* Effect.tryPromise({
      try: () => Fs.realpath(absolutePath),
      catch: (cause) => filesystemFailure("realpath", absolutePath, cause),
    });
    if (!ArtifactPaths.isCanonicalChild(canonicalRoot, canonicalPath))
      return yield* new ArtifactContracts.DagArtifactContainment({ path: relativePath });
    const stat = yield* Effect.tryPromise({
      try: () => Fs.stat(canonicalPath),
      catch: (cause) => filesystemFailure("stat", canonicalPath, cause),
    });
    if (!stat.isFile()) return yield* new ArtifactContracts.DagArtifactNotFile({ path: relativePath });
    return { root: canonicalRoot, relativePath: normalized, absolutePath, canonicalPath, stat };
  });
}

function readBounded(
  handle: FileHandle,
  pathForError: string,
  bytes: number,
  hardLimit: number,
): Effect.Effect<Buffer, ArtifactContracts.DagArtifactFailure> {
  return Effect.tryPromise({
    try: async () => {
      const readLimit = Math.min(bytes, hardLimit) + 1;
      const chunks: Buffer[] = [];
      let total = 0;
      let position = 0;
      while (total < readLimit) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, readLimit - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        chunks.push(buffer.subarray(0, bytesRead));
        total += bytesRead;
        position += bytesRead;
      }
      return Buffer.concat(chunks, total);
    },
    catch: (cause) => filesystemFailure("read", pathForError, cause),
  });
}

function openNoFollow(canonicalPath: string): Effect.Effect<FileHandle, ArtifactContracts.DagArtifactFailure> {
  // Node exposes no openat-style directory descriptor API; K5 therefore cannot prove race-free containment
  // against unobservable intermediate-directory replacement. This boundary fails closed for observable
  // final-path replacement using canonical path, stat identity, size, and digest checks.
  return Effect.tryPromise({
    try: () => Fs.open(canonicalPath, FsConstants.O_RDONLY | noFollow),
    catch: (cause) => filesystemFailure("open", canonicalPath, cause),
  });
}

function statOpenHandle(handle: FileHandle, pathForError: string): Effect.Effect<FileStat, ArtifactContracts.DagArtifactFailure> {
  return Effect.tryPromise({
    try: () => handle.stat(),
    catch: (cause) => filesystemFailure("fstat", pathForError, cause),
  });
}

function closeHandle(handle: FileHandle, pathForError: string): Effect.Effect<void, ArtifactContracts.DagArtifactFailure> {
  return Effect.tryPromise({
    try: () => handle.close(),
    catch: (cause) => filesystemFailure("close", pathForError, cause),
  });
}

function verifyPostRead(file: CanonicalFile, handleStatAfterRead: FileStat): Effect.Effect<void, ArtifactContracts.DagArtifactFailure> {
  return Effect.gen(function* () {
    const canonicalPath = yield* Effect.tryPromise({
      try: () => Fs.realpath(file.absolutePath),
      catch: (cause) => filesystemFailure("realpath", file.absolutePath, cause),
    });
    if (canonicalPath !== file.canonicalPath || !ArtifactPaths.isCanonicalChild(file.root, canonicalPath))
      return yield* new ArtifactContracts.DagArtifactChanged({ path: file.relativePath });
    const stat = yield* Effect.tryPromise({
      try: () => Fs.stat(file.canonicalPath),
      catch: (cause) => filesystemFailure("stat", file.canonicalPath, cause),
    });
    if (!statIdentityEqual(handleStatAfterRead, stat)) return yield* new ArtifactContracts.DagArtifactChanged({ path: file.relativePath });
  });
}

function readStableBytes(
  file: CanonicalFile,
  bytes: number,
  hardLimit: number,
): Effect.Effect<Buffer, ArtifactContracts.DagArtifactFailure> {
  return Effect.acquireUseRelease(
    openNoFollow(file.canonicalPath),
    (handle) =>
      Effect.gen(function* () {
        const openedStat = yield* statOpenHandle(handle, file.canonicalPath);
        if (!statIdentityEqual(file.stat, openedStat))
          return yield* new ArtifactContracts.DagArtifactChanged({ path: file.relativePath });
        const content = yield* readBounded(handle, file.relativePath, bytes, hardLimit);
        const afterStat = yield* statOpenHandle(handle, file.canonicalPath);
        if (!statIdentityEqual(openedStat, afterStat))
          return yield* new ArtifactContracts.DagArtifactChanged({ path: file.relativePath });
        yield* verifyPostRead(file, afterStat);
        return content;
      }),
    (handle) => closeHandle(handle, file.canonicalPath),
  );
}

export function readDagArtifactBytes(
  root: string,
  reference: ArtifactContracts.DagTextArtifactReference,
  remainingLimit: number,
): Effect.Effect<Buffer, ArtifactContracts.DagArtifactFailure> {
  return Effect.gen(function* () {
    if (reference.mediaType !== ArtifactContracts.DagTextArtifactMediaType || reference.encoding !== ArtifactContracts.DagTextArtifactEncoding)
      return yield* new ArtifactContracts.DagArtifactUnsupportedMedia({ path: reference.path });
    if (reference.bytes > ArtifactContracts.DagDefaultArtifactLimits.maxArtifactBytes)
      return yield* new ArtifactContracts.DagArtifactLimitExceeded({
        path: reference.path,
        actual: reference.bytes,
        max: ArtifactContracts.DagDefaultArtifactLimits.maxArtifactBytes,
      });
    if (reference.bytes > remainingLimit)
      return yield* new ArtifactContracts.DagArtifactContextLimitExceeded({ actual: reference.bytes, max: remainingLimit });
    const file = yield* resolveCanonicalFile(root, reference.path);
    const fileSize = statSize(file.stat);
    if (fileSize !== reference.bytes)
      return yield* new ArtifactContracts.DagArtifactSizeMismatch({ path: reference.path, expected: reference.bytes, actual: fileSize });
    const bytes = yield* readStableBytes(file, reference.bytes, remainingLimit);
    if (bytes.length !== reference.bytes)
      return yield* new ArtifactContracts.DagArtifactSizeMismatch({ path: reference.path, expected: reference.bytes, actual: bytes.length });
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== reference.digest) return yield* new ArtifactContracts.DagArtifactDigestMismatch({ path: reference.path });
    return bytes;
  });
}

export function admitDagArtifactFile(
  root: string,
  runId: string,
  producerNodeId: string,
  outputName: string,
  relativePath: string,
  nodeBytesBefore: number,
): Effect.Effect<ArtifactContracts.DagTextArtifactReference, ArtifactContracts.DagArtifactFailure> {
  return Effect.gen(function* () {
    const file = yield* resolveCanonicalFile(root, relativePath);
    const fileSize = statSize(file.stat);
    if (fileSize > ArtifactContracts.DagDefaultArtifactLimits.maxArtifactBytes)
      return yield* new ArtifactContracts.DagArtifactLimitExceeded({ path: relativePath, actual: fileSize, max: ArtifactContracts.DagDefaultArtifactLimits.maxArtifactBytes });
    if (nodeBytesBefore + fileSize > ArtifactContracts.DagDefaultArtifactLimits.maxBytesPerNode)
      return yield* new ArtifactContracts.DagArtifactNodeLimitExceeded({
        producerNodeId,
        actual: nodeBytesBefore + fileSize,
        max: ArtifactContracts.DagDefaultArtifactLimits.maxBytesPerNode,
      });
    const temporary = Object.freeze({
      v: ArtifactContracts.DagTextArtifactReferenceVersion,
      path: file.relativePath,
      bytes: fileSize,
      digestAlgorithm: ArtifactContracts.DagTextArtifactDigestAlgorithm,
      digest: "0".repeat(64),
      mediaType: ArtifactContracts.DagTextArtifactMediaType,
      encoding: ArtifactContracts.DagTextArtifactEncoding,
      runId,
      producerNodeId,
      outputName,
    } satisfies ArtifactContracts.DagTextArtifactReference);
    const bytes = yield* readStableBytes(file, temporary.bytes, ArtifactContracts.DagDefaultArtifactLimits.maxArtifactBytes);
    if (bytes.length !== temporary.bytes)
      return yield* new ArtifactContracts.DagArtifactSizeMismatch({ path: temporary.path, expected: temporary.bytes, actual: bytes.length });
    yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: (cause) => new ArtifactContracts.DagArtifactUtf8({ path: temporary.path, cause }),
    });
    return Object.freeze({ ...temporary, digest: createHash("sha256").update(bytes).digest("hex") });
  });
}
