import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Fs from "node:fs/promises";
import path from "node:path";
import { Data, Effect } from "effect";
import { Check } from "typebox/value";
import {
  DagExecutorKind,
  DagSubagentReservedOutputTokens,
  materializeDagTextContext,
  publishDagSubagentTextResult,
  type DagEffectExecutor,
  type DagTextArtifactReference,
} from "../../../src/dag/index.js";
import { isPathContained } from "../_shared/path-containment";
import { parseDiffGitPath, parsePatchFilePath, sha256, validatePlan } from "./core";
import { PlanSchema, type EvidenceReference, type ReviewPlan } from "./schema";

export const ReviewEvidenceResolverKey = "pr-review/evidence-resolver-v1" as const;
export const ReviewEvidenceDossierMaxBytes = 160_000 as const;
export const ReviewEvidenceCoverageOutput = "evidence_coverage" as const;
export const ReviewEvidenceChunkOutputs = Object.freeze([
  "evidence_chunk_1",
  "evidence_chunk_2",
  "evidence_chunk_3",
  "evidence_chunk_4",
] as const);
export const ReviewEvidenceOutputs = Object.freeze([
  ReviewEvidenceCoverageOutput,
  ...ReviewEvidenceChunkOutputs,
]);
const ChunkMaxBytes = 220_000;
const MaxRangeLines = 1_000;
const MaxSourceFileBytes = 8_000_000;
const ReviewerPromptFixedReserveBytes = 24_000;
const execFileAsync = promisify(execFile);

export interface ReviewEvidenceResolverPayloadV1 {
  readonly v: 1;
  readonly snapshotId: string;
  readonly headOid: string;
  readonly diffHash: string;
  readonly worktree: string;
  readonly diffPath: string;
  readonly changedPaths: readonly string[];
  readonly planOutputName: string;
  readonly reviewerContextWindow: number;
}

export interface ReviewEvidenceCoverage {
  readonly v: 1;
  readonly snapshotId: string;
  readonly headOid: string;
  readonly diffHash: string;
  readonly digest: string;
  readonly uniqueBytes: number;
  readonly dossierBytes: number;
  readonly chunks: number;
  readonly chunkOutputs: readonly string[];
  readonly omissions: readonly string[];
  readonly references: number;
}

export class ReviewEvidenceResolutionFailure extends Data.TaggedError(
  "ReviewEvidenceResolutionFailure",
)<{
  readonly code:
    | "invalid-payload"
    | "invalid-plan"
    | "snapshot-mismatch"
    | "unplanned-path"
    | "invalid-range"
    | "missing-file"
    | "not-file"
    | "containment"
    | "symlink-escape"
    | "artifact-overflow"
    | "producer-overflow"
    | "prompt-overflow";
  readonly message: string;
  readonly path?: string;
  readonly actual?: number;
  readonly limit?: number;
  readonly cause?: unknown;
}> {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
const PayloadKeys = Object.freeze([
  "v",
  "snapshotId",
  "headOid",
  "diffHash",
  "worktree",
  "diffPath",
  "changedPaths",
  "planOutputName",
  "reviewerContextWindow",
]);
function validAbsolutePath(value: unknown): value is string {
  return nonEmpty(value) && path.isAbsolute(value);
}
function validChangedPaths(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000) return false;
  if (value.some((item) => !nonEmpty(item))) return false;
  return new Set(value).size === value.length;
}
function validPayloadRecord(value: Record<string, unknown>): boolean {
  if (!exactKeys(value, PayloadKeys) || value.v !== 1) return false;
  if (!nonEmpty(value.snapshotId) || !nonEmpty(value.headOid)) return false;
  if (!nonEmpty(value.diffHash) || !/^[0-9a-f]{64}$/u.test(value.diffHash)) return false;
  if (!validAbsolutePath(value.worktree) || !validAbsolutePath(value.diffPath)) return false;
  return (
    validChangedPaths(value.changedPaths) &&
    nonEmpty(value.planOutputName) &&
    typeof value.reviewerContextWindow === "number" &&
    Number.isSafeInteger(value.reviewerContextWindow) &&
    value.reviewerContextWindow > 4_096
  );
}
function parsePayload(value: unknown): ReviewEvidenceResolverPayloadV1 {
  if (!isRecord(value) || !validPayloadRecord(value))
    throw new ReviewEvidenceResolutionFailure({
      code: "invalid-payload",
      message: "Evidence resolver payload does not match the v1 contract.",
    });
  return Object.freeze({
    v: 1,
    snapshotId: value.snapshotId as string,
    headOid: value.headOid as string,
    diffHash: value.diffHash as string,
    worktree: value.worktree as string,
    diffPath: value.diffPath as string,
    changedPaths: Object.freeze([...(value.changedPaths as string[])]),
    planOutputName: value.planOutputName as string,
    reviewerContextWindow: value.reviewerContextWindow as number,
  });
}

function validRelativePath(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    !path.isAbsolute(candidate) &&
    candidate === path.normalize(candidate) &&
    candidate !== ".." &&
    !candidate.startsWith(`..${path.sep}`)
  );
}

interface LineSpan {
  readonly start: number;
  readonly contentEnd: number;
}
function lineSpans(text: string): readonly LineSpan[] {
  const spans: LineSpan[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    const contentEnd = index > start && text[index - 1] === "\r" ? index - 1 : index;
    spans.push({ start, contentEnd });
    start = index + 1;
  }
  if (start < text.length || text.length === 0) spans.push({ start, contentEnd: text.length });
  return spans;
}
function selectLines(text: string, reference: EvidenceReference): string {
  const count = reference.endLine - reference.startLine + 1;
  const spans = lineSpans(text);
  if (
    reference.endLine < reference.startLine ||
    count > MaxRangeLines ||
    reference.endLine > spans.length
  )
    throw new ReviewEvidenceResolutionFailure({
      code: "invalid-range",
      message: `Evidence range ${reference.startLine}-${reference.endLine} is invalid for ${reference.path}.`,
      path: reference.path,
    });
  const first = spans[reference.startLine - 1];
  const last = spans[reference.endLine - 1];
  return text.slice(first.start, last.contentEnd);
}
function diffSections(diff: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string[]>();
  for (const chunk of diff.split(/^diff --git /mu).filter(Boolean)) {
    const text = `diff --git ${chunk}`;
    const lines = text.split(/\r?\n/u);
    const destination = parsePatchFilePath(lines.find((line) => line.startsWith("+++ ")) ?? "");
    const source = parsePatchFilePath(lines.find((line) => line.startsWith("--- ")) ?? "");
    const file =
      (destination && destination !== "/dev/null" ? destination : undefined) ??
      (source && source !== "/dev/null" ? source : undefined) ??
      parseDiffGitPath(lines[0] ?? "");
    if (!file) continue;
    const current = sections.get(file) ?? [];
    current.push(text);
    sections.set(file, current);
  }
  return new Map([...sections].map(([file, chunks]) => [file, chunks.join("\n")]));
}

async function readSourceRange(
  root: string,
  reference: EvidenceReference,
): Promise<string> {
  if (!validRelativePath(reference.path))
    throw new ReviewEvidenceResolutionFailure({
      code: "containment",
      message: `Evidence path is not a normalized relative path: ${reference.path}.`,
      path: reference.path,
    });
  const candidate = path.join(root, reference.path);
  let canonical: string;
  try {
    const directStats = await Fs.lstat(candidate);
    if (directStats.isSymbolicLink())
      throw new ReviewEvidenceResolutionFailure({
        code: "symlink-escape",
        message: `File evidence cannot dereference a symbolic link: ${reference.path}. Use diff evidence instead.`,
        path: reference.path,
      });
    canonical = await Fs.realpath(candidate);
  } catch (cause) {
    if (cause instanceof ReviewEvidenceResolutionFailure) throw cause;
    throw new ReviewEvidenceResolutionFailure({
      code: "missing-file",
      message: `Evidence file does not exist: ${reference.path}.`,
      path: reference.path,
      cause,
    });
  }
  if (!isPathContained(root, canonical))
    throw new ReviewEvidenceResolutionFailure({
      code: "symlink-escape",
      message: `Evidence path resolves outside the pinned worktree: ${reference.path}.`,
      path: reference.path,
    });
  const stats = await Fs.stat(canonical);
  if (!stats.isFile())
    throw new ReviewEvidenceResolutionFailure({
      code: "not-file",
      message: `Evidence path is not a file: ${reference.path}.`,
      path: reference.path,
    });
  if (stats.size > MaxSourceFileBytes)
    throw new ReviewEvidenceResolutionFailure({
      code: "artifact-overflow",
      message: `Evidence source file exceeds the resolver byte limit: ${reference.path}.`,
      path: reference.path,
      actual: stats.size,
      limit: MaxSourceFileBytes,
    });
  return selectLines(await Fs.readFile(canonical, "utf8"), reference);
}

function uncoveredDiffHunks(
  plan: ReviewPlan,
  sections: ReadonlyMap<string, string>,
): string[] {
  const diffReferences = plan.evidence.filter((reference) => reference.kind === "diff");
  const omissions: string[] = [];
  for (const [file, section] of sections) {
    const lines = section.split(/\r?\n/u);
    const sectionLineCount = lineSpans(section).length;
    const starts = lines.flatMap((line, index) => (line.startsWith("@@ ") ? [index + 1] : []));
    for (const [index, startLine] of starts.entries()) {
      const endLine = (starts[index + 1] ?? sectionLineCount + 1) - 1;
      const covered = diffReferences.some(
        (reference) =>
          reference.path === file &&
          reference.startLine <= startLine &&
          reference.endLine >= endLine,
      );
      if (!covered) omissions.push(`${file}:diff-lines ${startLine}-${endLine}`);
    }
  }
  return omissions;
}

function byteChunks(text: string): string[] {
  const encoded = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  let start = 0;
  while (start < encoded.length) {
    let end = Math.min(start + ChunkMaxBytes, encoded.length);
    while (end > start && end < encoded.length && (encoded[end] & 0xc0) === 0x80) end -= 1;
    if (end === start)
      throw new ReviewEvidenceResolutionFailure({
        code: "artifact-overflow",
        message: "Evidence could not be split at a UTF-8 boundary.",
      });
    chunks.push(encoded.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}

async function verifySnapshot(payload: ReviewEvidenceResolverPayloadV1, signal: AbortSignal) {
  const [canonicalWorktree, diff] = await Promise.all([
    Fs.realpath(payload.worktree),
    Fs.readFile(payload.diffPath, "utf8"),
  ]).catch((cause) => {
    throw new ReviewEvidenceResolutionFailure({
      code: "snapshot-mismatch",
      message: "Pinned snapshot paths are not available.",
      cause,
    });
  });
  if (sha256(diff) !== payload.diffHash)
    throw new ReviewEvidenceResolutionFailure({
      code: "snapshot-mismatch",
      message: "Pinned diff identity does not match the resolver payload.",
    });
  let head: string;
  try {
    const [headResult, statusResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: canonicalWorktree,
        encoding: "utf8",
        signal,
      }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: canonicalWorktree,
        encoding: "utf8",
        signal,
      }),
    ]);
    head = headResult.stdout.trim();
    if (statusResult.stdout.length > 0)
      throw new ReviewEvidenceResolutionFailure({
        code: "snapshot-mismatch",
        message: "Pinned worktree contains changes after snapshot preparation.",
      });
  } catch (cause) {
    throw new ReviewEvidenceResolutionFailure({
      code: "snapshot-mismatch",
      message: "Pinned worktree identity could not be verified.",
      cause,
    });
  }
  if (head !== payload.headOid)
    throw new ReviewEvidenceResolutionFailure({
      code: "snapshot-mismatch",
      message: "Pinned worktree HEAD does not match the resolver payload.",
    });
  return { canonicalWorktree, diff };
}

async function resolveEvidence(
  payload: ReviewEvidenceResolverPayloadV1,
  plan: ReviewPlan,
  signal: AbortSignal,
): Promise<{ coverage: ReviewEvidenceCoverage; chunks: readonly string[] }> {
  const snapshot = await verifySnapshot(payload, signal);
  const changed = new Set(payload.changedPaths);
  const sections = diffSections(snapshot.diff);
  const seen = new Map<string, string>();
  const blocks: string[] = [];
  let uniqueBytes = 0;
  for (const [index, reference] of plan.evidence.entries()) {
    if (signal.aborted) throw signal.reason;
    if (!changed.has(reference.path))
      throw new ReviewEvidenceResolutionFailure({
        code: "unplanned-path",
        message: `Evidence path is not part of the pinned changed-path plan: ${reference.path}.`,
        path: reference.path,
      });
    const identity = JSON.stringify([
      reference.kind,
      reference.path,
      reference.startLine,
      reference.endLine,
    ]);
    let text = seen.get(identity);
    if (text === undefined) {
      if (reference.kind === "file") text = await readSourceRange(snapshot.canonicalWorktree, reference);
      else {
        const section = sections.get(reference.path);
        if (section === undefined)
          throw new ReviewEvidenceResolutionFailure({
            code: "missing-file",
            message: `Pinned diff has no section for ${reference.path}.`,
            path: reference.path,
          });
        text = selectLines(section, reference);
      }
      seen.set(identity, text);
      uniqueBytes += Buffer.byteLength(text, "utf8");
    }
    blocks.push(
      [
        `=== Evidence ${index + 1}: ${reference.kind} ${reference.path}:${reference.startLine}-${reference.endLine} ===`,
        `Purpose: ${reference.purpose}`,
        text,
      ].join("\n"),
    );
  }
  const dossier = blocks.join("\n\n");
  const dossierBytes = Buffer.byteLength(dossier, "utf8");
  if (dossierBytes > ReviewEvidenceDossierMaxBytes)
    throw new ReviewEvidenceResolutionFailure({
      code: "producer-overflow",
      message: "Resolved evidence exceeds the fixed dossier admission limit.",
      actual: dossierBytes,
      limit: ReviewEvidenceDossierMaxBytes,
    });
  const chunks = byteChunks(dossier);
  const padded = ReviewEvidenceChunkOutputs.map((_, index) => chunks[index] ?? "");
  const coverage = Object.freeze({
    v: 1,
    snapshotId: payload.snapshotId,
    headOid: payload.headOid,
    diffHash: payload.diffHash,
    digest: createHash("sha256").update(dossier).digest("hex"),
    uniqueBytes,
    dossierBytes,
    chunks: chunks.length,
    chunkOutputs: Object.freeze(ReviewEvidenceChunkOutputs.slice(0, chunks.length)),
    omissions: Object.freeze([
      ...(plan.evidenceOmissions ?? []),
      ...uncoveredDiffHunks(plan, sections),
    ]),
    references: plan.evidence.length,
  } satisfies ReviewEvidenceCoverage);
  return { coverage, chunks: Object.freeze(padded) };
}

export function makeReviewEvidenceResolverExecutor(options: {
  readonly artifactRoot: string;
}): DagEffectExecutor {
  return (request) =>
    Effect.gen(function* () {
      const payload = yield* Effect.try({
        try: () => parsePayload(request.node.executor.payload),
        catch: (cause) =>
          cause instanceof ReviewEvidenceResolutionFailure
            ? cause
            : new ReviewEvidenceResolutionFailure({
                code: "invalid-payload",
                message: "Evidence resolver payload could not be decoded.",
                cause,
              }),
      });
      const context = yield* materializeDagTextContext(
        options.artifactRoot,
        request.runId,
        request.node,
        request.graphState,
        [payload.planOutputName],
      );
      const plan = yield* Effect.try({
        try: () => {
          const decoded = JSON.parse(context.outputs[0]?.text ?? "") as unknown;
          const changedFiles = payload.changedPaths.map((path) => ({ path }));
          if (!Check(PlanSchema, decoded) || !validatePlan(decoded, changedFiles).ok)
            throw new ReviewEvidenceResolutionFailure({
              code: "invalid-plan",
              message: "Reading plan evidence index is malformed or incomplete.",
            });
          return decoded;
        },
        catch: (cause) =>
          cause instanceof ReviewEvidenceResolutionFailure
            ? cause
            : new ReviewEvidenceResolutionFailure({
                code: "invalid-plan",
                message: "Reading plan evidence index could not be decoded.",
                cause,
              }),
      });
      const resolved = yield* Effect.tryPromise({
        try: (signal) => resolveEvidence(payload, plan, signal),
        catch: (cause) =>
          cause instanceof ReviewEvidenceResolutionFailure
            ? cause
            : new ReviewEvidenceResolutionFailure({
                code: "invalid-plan",
                message: "Evidence resolution failed.",
                cause,
              }),
      });
      const projectedPromptBytes =
        Buffer.byteLength(JSON.stringify(context.outputs[0]?.text ?? ""), "utf8") +
        Buffer.byteLength(JSON.stringify(resolved.coverage), "utf8") +
        resolved.chunks.reduce(
          (total, chunk) => total + Buffer.byteLength(JSON.stringify(chunk), "utf8"),
          0,
        ) +
        ReviewerPromptFixedReserveBytes;
      const promptLimit = payload.reviewerContextWindow - DagSubagentReservedOutputTokens;
      if (projectedPromptBytes > promptLimit)
        return yield* new ReviewEvidenceResolutionFailure({
          code: "prompt-overflow",
          message: "Resolved evidence exceeds conservative reviewer prompt admission.",
          actual: projectedPromptBytes,
          limit: promptLimit,
        });
      const outputs: Record<string, DagTextArtifactReference> = {};
      const content = {
        [ReviewEvidenceCoverageOutput]: JSON.stringify(resolved.coverage),
        ...Object.fromEntries(
          ReviewEvidenceChunkOutputs.map((outputName, index) => [outputName, resolved.chunks[index]]),
        ),
      };
      for (const [outputName, text] of Object.entries(content)) {
        const published = yield* publishDagSubagentTextResult(
          options.artifactRoot,
          request.runId,
          request.node.id,
          request.attemptId,
          outputName,
          text,
        );
        Object.assign(outputs, published);
      }
      return Object.freeze(outputs);
    });
}

export const ReviewEvidenceExecutorKind = DagExecutorKind.Materialize;
