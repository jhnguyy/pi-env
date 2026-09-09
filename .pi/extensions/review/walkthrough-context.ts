import { existsSync, readFileSync } from "node:fs";
import { bound, parseDiffGitPath, sha256, type Finding, type ReviewState } from "./core";

const MAX_DIFF_BYTES = 8_000_000;
const DIFF_PAGE_CHARS = 3_500;

export function pinnedContext(state: ReviewState): string {
  const metadata = state.snapshot.metadata;
  return bound(
    [
      `PR: ${metadata.title ?? metadata.url}`,
      `Pinned head: ${metadata.headOid}`,
      `Base: ${metadata.baseOid}`,
      metadata.body ? `Description: ${metadata.body}` : "Description: unavailable",
    ].join("\n"),
    4_000,
  );
}

export function readVerifiedPinnedDiff(state: ReviewState): string {
  const { diffPath, diffHash } = state.snapshot;
  if (!diffHash || !existsSync(diffPath)) throw new Error("Pinned diff evidence is unavailable.");
  const diff = readFileSync(diffPath, "utf8");
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES)
    throw new Error("Pinned diff exceeds the walkthrough evidence limit.");
  if (sha256(diff) !== diffHash)
    throw new Error("Pinned diff integrity check failed. Refusing unverified evidence.");
  return diff;
}

function fileSection(diff: string, path: string): string | undefined {
  const lines = diff.split(/\r?\n/u);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseDiffGitPath(lines[index] ?? "");
    if (parsed === path) start = index;
    else if (parsed && start >= 0) {
      end = index;
      break;
    }
  }
  return start < 0 ? undefined : lines.slice(start, end).join("\n");
}

export interface PinnedDiffPage {
  readonly number: number;
  readonly total: number;
  readonly text: string;
}

export function pinnedDiffPages(state: ReviewState, path: string): readonly PinnedDiffPage[] {
  const section = fileSection(readVerifiedPinnedDiff(state), path);
  if (section === undefined) return [{ number: 1, total: 1, text: `No pinned diff section for ${path}.` }];
  const pages: string[] = [];
  for (let offset = 0; offset < section.length; offset += DIFF_PAGE_CHARS)
    pages.push(section.slice(offset, offset + DIFF_PAGE_CHARS));
  if (pages.length === 0) pages.push("(empty pinned diff section)");
  return pages.map((text, index) => ({ number: index + 1, total: pages.length, text }));
}

function anchoredLines(section: string, finding: Finding): string[] | undefined {
  if (!finding.line || !finding.side) return undefined;
  const lines = section.split(/\r?\n/u);
  let oldLine = 0;
  let newLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    const isMetadata = line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++");
    const sideLine = finding.side === "LEFT" ? oldLine : newLine;
    const existsOnSide = finding.side === "LEFT" ? !line.startsWith("+") : !line.startsWith("-");
    if (!isMetadata && existsOnSide && sideLine === finding.line)
      return lines.slice(Math.max(0, index - 5), Math.min(lines.length, index + 6));
    if (!isMetadata && !line.startsWith("+") && !line.startsWith("\\")) oldLine += 1;
    if (!isMetadata && !line.startsWith("-") && !line.startsWith("\\")) newLine += 1;
  }
  return undefined;
}

export function findingContext(state: ReviewState, findingId: string): string {
  const finding = state.result?.findings.find((candidate) => candidate.id === findingId);
  if (!finding) return "Finding not found.";
  const details = [
    finding.file ? `Anchor: ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "Anchor: unanchored",
    `Problem: ${finding.problem}`,
    `Consequence: ${finding.consequence}`,
    `Suggested fix: ${finding.suggestedFix}`,
  ];
  if (finding.anchorValid && finding.file) {
    const section = fileSection(readVerifiedPinnedDiff(state), finding.file);
    const evidence = section ? anchoredLines(section, finding) : undefined;
    details.push(
      "Pinned diff evidence (hash verified)",
      evidence?.join("\n") ?? "Anchor was validated previously, but bounded context could not be located.",
    );
  } else {
    details.push("Pinned diff evidence: unanchored finding. No source text is substituted.");
  }
  return details.join("\n");
}
