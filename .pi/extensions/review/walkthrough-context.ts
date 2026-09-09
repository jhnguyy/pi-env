import { bound, type ReviewState } from "./core";

export function pinnedContext(state: ReviewState): string {
  const metadata = state.snapshot.metadata;
  return bound([
    `PR: ${metadata.title ?? metadata.url}`,
    `Pinned head: ${metadata.headOid}`,
    `Base: ${metadata.baseOid}`,
    metadata.body ? `Description: ${metadata.body}` : "Description: unavailable",
  ].join("\n"), 4000);
}

export function findingContext(state: ReviewState, findingId: string): string {
  const finding = state.result?.findings.find((candidate) => candidate.id === findingId);
  if (!finding) return "Finding not found.";
  return bound([
    finding.file ? `Anchor: ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "Anchor: unanchored",
    `Problem: ${finding.problem}`,
    `Consequence: ${finding.consequence}`,
    `Suggested fix: ${finding.suggestedFix}`,
  ].join("\n"), 2000);
}
