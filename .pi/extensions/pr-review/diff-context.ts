import { readFileSync } from "fs";
import { createHash } from "crypto";
import type { ReviewSnapshot } from "./schema";
import { parseDiffGitPath, parsePatchFilePath } from "./core";

export type DiffSide = "LEFT" | "RIGHT";

export type DiffContextError =
  | { kind: "unreadable_artifact"; path: string; message: string }
  | { kind: "hash_mismatch"; path: string; expected: string; actual: string }
  | { kind: "missing_file"; file: string }
  | { kind: "malformed_anchor"; message: string }
  | { kind: "bound_failure"; message: string; maxLines: number; maxBytes: number };

export type DiffContextResult<T> = { ok: true; value: T } | { ok: false; error: DiffContextError };

export interface DiffLine {
  text: string;
  oldLine?: number;
  newLine?: number;
  sides: Partial<Record<DiffSide, number>>;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffFileChunk {
  path: string;
  text: string;
  hunks: DiffHunk[];
}

export interface PinnedDiff {
  text: string;
  byPath: Map<string, DiffFileChunk[]>;
}

export interface FindingAnchor {
  file?: string;
  side?: DiffSide;
  line?: number;
}

export interface ContextOptions {
  contextLines?: number;
  maxLines?: number;
  maxBytes?: number;
}

const DEFAULT_MAX_LINES = 25;
const DEFAULT_MAX_BYTES = 8192;
const DEFAULT_CONTEXT_LINES = 6;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function countBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function lineNumbers(line: string, oldLine: number, newLine: number): DiffLine {
  if (line.startsWith("+")) return { text: line, newLine, sides: { RIGHT: newLine } };
  if (line.startsWith("-")) return { text: line, oldLine, sides: { LEFT: oldLine } };
  if (line.startsWith(" "))
    return { text: line, oldLine, newLine, sides: { LEFT: oldLine, RIGHT: newLine } };
  return { text: line, sides: {} };
}

function advance(line: string, oldLine: number, newLine: number): { oldLine: number; newLine: number } {
  if (line.startsWith("+")) return { oldLine, newLine: newLine + 1 };
  if (line.startsWith("-")) return { oldLine: oldLine + 1, newLine };
  if (line.startsWith(" ")) return { oldLine: oldLine + 1, newLine: newLine + 1 };
  return { oldLine, newLine };
}

function splitChunks(diff: string): string[] {
  return diff
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((chunk) => `diff --git ${chunk}`);
}

function parseChunk(text: string): DiffFileChunk | undefined {
  const lines = text.split(/\r?\n/);
  const path = parseDiffGitPath(lines[0] ?? "") ?? lines.map(parsePatchFilePath).find(Boolean);
  if (!path) return undefined;
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const [index, line] of lines.entries()) {
    if (line === "" && index === lines.length - 1) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*$/);
    if (hunk) {
      current = { header: line, oldStart: Number(hunk[1]), newStart: Number(hunk[2]), lines: [] };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }
    if (!current) continue;
    const numbered = lineNumbers(line, oldLine, newLine);
    current.lines.push(numbered);
    ({ oldLine, newLine } = advance(line, oldLine, newLine));
  }
  return { path, text, hunks };
}

export function loadPinnedDiff(snapshot: ReviewSnapshot): DiffContextResult<PinnedDiff> {
  let text: string;
  try {
    text = readFileSync(snapshot.diffPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: { kind: "unreadable_artifact", path: snapshot.diffPath, message: String(error) },
    };
  }
  const actual = sha256(text);
  if (actual !== snapshot.diffHash)
    return { ok: false, error: { kind: "hash_mismatch", path: snapshot.diffPath, expected: snapshot.diffHash, actual } };

  const byPath = new Map<string, DiffFileChunk[]>();
  for (const textChunk of splitChunks(text)) {
    const chunk = parseChunk(textChunk);
    if (!chunk) continue;
    const chunks = byPath.get(chunk.path) ?? [];
    chunks.push(chunk);
    byPath.set(chunk.path, chunks);
  }
  return { ok: true, value: { text, byPath } };
}

function validateAnchor(anchor: FindingAnchor): DiffContextError | undefined {
  if (!anchor.file) return { kind: "malformed_anchor", message: "Finding anchor is missing a file." };
  if (anchor.side !== "LEFT" && anchor.side !== "RIGHT")
    return { kind: "malformed_anchor", message: "Finding anchor side must be LEFT or RIGHT." };
  if (!Number.isInteger(anchor.line) || (anchor.line ?? 0) < 1)
    return { kind: "malformed_anchor", message: "Finding anchor line must be a positive integer." };
  return undefined;
}

function fits(lines: string[], maxLines: number, maxBytes: number): boolean {
  return lines.length <= maxLines && countBytes(lines.join("\n")) <= maxBytes;
}

export function extractFindingContext(
  diff: PinnedDiff,
  anchor: FindingAnchor,
  options: ContextOptions = {},
): DiffContextResult<string> {
  const malformed = validateAnchor(anchor);
  if (malformed) return { ok: false, error: malformed };

  const file = anchor.file!;
  const side = anchor.side!;
  const line = anchor.line!;
  const chunks = diff.byPath.get(file);
  if (!chunks?.length) return { ok: false, error: { kind: "missing_file", file } };

  for (const chunk of chunks) {
    for (const hunk of chunk.hunks) {
      const index = hunk.lines.findIndex((l) => l.sides[side] === line);
      if (index < 0) continue;
      const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      if (maxLines < 2 || maxBytes < countBytes(`${hunk.header}\n${hunk.lines[index]!.text}`))
        return {
          ok: false,
          error: { kind: "bound_failure", message: "Bounds cannot include the hunk header and anchor line.", maxLines, maxBytes },
        };

      const requested = Math.max(0, options.contextLines ?? DEFAULT_CONTEXT_LINES);
      for (let radius = requested; radius >= 0; radius -= 1) {
        const selected = [
          hunk.header,
          ...hunk.lines.slice(Math.max(0, index - radius), index + radius + 1).map((l) => l.text),
        ];
        if (fits(selected, maxLines, maxBytes)) return { ok: true, value: selected.join("\n") };
      }
      return {
        ok: false,
        error: { kind: "bound_failure", message: "Bounds cannot include the requested anchor context.", maxLines, maxBytes },
      };
    }
  }
  return { ok: false, error: { kind: "malformed_anchor", message: "Anchor is not present on the requested side." } };
}
