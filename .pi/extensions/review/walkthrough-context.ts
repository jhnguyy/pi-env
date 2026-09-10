import { bound, type ReviewState } from "./core";
import {
  createDiffIndex,
  type DiffAnchorSide,
  type DiffIndex,
  type DiffIndexEntry,
} from "./diff-index";
import { readVerifiedPinnedDiff } from "./snapshot";

const MAX_ANCHOR_CONTEXT_CHARS = 12_000;

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

function lineWindow(text: string, anchorOffset: number, radius: number): string {
  const lowerBound = Math.max(0, anchorOffset - MAX_ANCHOR_CONTEXT_CHARS / 2);
  const upperBound = Math.min(text.length, anchorOffset + MAX_ANCHOR_CONTEXT_CHARS / 2);
  let start = anchorOffset;
  let end = anchorOffset;
  for (let lines = 0; lines <= radius && start > lowerBound; lines += 1) {
    const previous = text.lastIndexOf("\n", start - 1);
    start = previous < lowerBound ? lowerBound : previous;
  }
  if (text[start] === "\n") start += 1;
  for (let lines = 0; lines <= radius && end < upperBound; lines += 1) {
    const next = text.indexOf("\n", end);
    end = next < 0 || next > upperBound ? upperBound : next + 1;
  }
  return text.slice(start, end).replace(/\n$/u, "");
}

function anchorEvidence(
  entry: DiffIndexEntry,
  side: DiffAnchorSide,
  line: number,
): string | undefined {
  const offsets = entry.anchors[side].get(line);
  const offset = offsets?.at(0);
  return offset === undefined ? undefined : lineWindow(entry.text, offset, 5);
}

export interface WalkthroughContext {
  readonly fileDiff: (path: string) => string;
  readonly finding: (findingId: string) => string;
}

/** Creates invocation-local walkthrough evidence. The verified index is loaded once, on first use. */
export function createWalkthroughContext(state: () => ReviewState): WalkthroughContext {
  const snapshot = state().snapshot;
  let index: DiffIndex | undefined;
  const diffIndex = () => (index ??= createDiffIndex(readVerifiedPinnedDiff(snapshot)));
  return {
    fileDiff(path) {
      return diffIndex().get(path)?.text ?? `No pinned diff section for ${path}.`;
    },
    finding(findingId) {
      const finding = state().result?.findings.find((candidate) => candidate.id === findingId);
      if (!finding) return "Finding not found.";
      const details = [
        finding.file
          ? `Anchor: ${finding.file}${finding.line ? `:${finding.line}` : ""}`
          : "Anchor: unanchored",
        `Problem: ${finding.problem}`,
        `Consequence: ${finding.consequence}`,
        `Suggested fix: ${finding.suggestedFix}`,
      ];
      if (finding.anchorValid && finding.file && finding.line && finding.side) {
        const entry = diffIndex().get(finding.file);
        const evidence = entry ? anchorEvidence(entry, finding.side, finding.line) : undefined;
        details.push(
          "Pinned diff evidence (hash verified)",
          evidence ?? "Anchor was validated previously, but bounded context could not be located.",
        );
      } else {
        details.push("Pinned diff evidence: unanchored finding. No source text is substituted.");
      }
      return details.join("\n");
    },
  };
}
