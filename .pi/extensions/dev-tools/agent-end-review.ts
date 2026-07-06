import { basename } from "node:path";
import type { AgentEndFileResult } from "./agent-end";
import { countAgentEndIssues, renderAgentEndSummary, shouldTriggerTurn } from "./agent-end";
import type { BackendName } from "./backend-configs";

export const AgentEndReadiness = {
  Ready: "ready",
  ReviewWarnings: "review-warnings",
  Blocked: "blocked",
  NotChecked: "not-checked",
} as const;
export type AgentEndReadiness = typeof AgentEndReadiness[keyof typeof AgentEndReadiness];

export const AgentEndBackendCheckKind = {
  Format: "format",
} as const;
export type AgentEndBackendCheckKind = typeof AgentEndBackendCheckKind[keyof typeof AgentEndBackendCheckKind];

export interface AgentEndBackendCheck {
  kind: AgentEndBackendCheckKind;
  backend: BackendName;
  files: string[];
}

export interface AgentEndReviewMetadata {
  checkedFiles: string[];
  skippedFiles: string[];
  backendChecks: AgentEndBackendCheck[];
  issueCounts: {
    errors: number;
    warnings: number;
    infos: number;
  };
  readiness: AgentEndReadiness;
}

export interface AgentEndReviewResult {
  summary: string;
  triggerTurn: boolean;
  metadata: AgentEndReviewMetadata;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function renderFileList(files: string[], limit = 6): string {
  const names = files.map((file) => basename(file));
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;
}

function readinessFromCounts(counts: AgentEndReviewMetadata["issueCounts"], checkedCount: number): AgentEndReadiness {
  switch (true) {
    case counts.errors > 0:
      return AgentEndReadiness.Blocked;
    case counts.warnings > 0:
      return AgentEndReadiness.ReviewWarnings;
    case checkedCount === 0:
      return AgentEndReadiness.NotChecked;
    default:
      return AgentEndReadiness.Ready;
  }
}

function renderBackendChecks(checks: AgentEndBackendCheck[]): string {
  if (checks.length === 0) return "none";
  return checks
    .map((check) => `${check.kind}:${check.backend} ${check.files.length}`)
    .join(", ");
}

const REVIEW_INSTRUCTIONS: Record<AgentEndReadiness, string> = {
  [AgentEndReadiness.Blocked]: "Readiness: blocked. Continue fixing these issues before asking for review.",
  [AgentEndReadiness.ReviewWarnings]: "Readiness: warnings. Review these before declaring the change ready.",
  [AgentEndReadiness.Ready]: "Readiness: clean. No post-edit issues were found.",
  [AgentEndReadiness.NotChecked]: "Readiness: not checked. No supported files were processed; run the appropriate project checks before review.",
};

export function buildAgentEndReviewResult(args: {
  checkedFiles: string[];
  skippedFiles: string[];
  backendChecks: AgentEndBackendCheck[];
  results: AgentEndFileResult[];
}): AgentEndReviewResult {
  const checkedFiles = uniqueSorted(args.checkedFiles);
  const skippedFiles = uniqueSorted(args.skippedFiles);
  const counts = countAgentEndIssues(args.results);
  const readiness = readinessFromCounts(counts, checkedFiles.length);
  const issueSummary = renderAgentEndSummary(args.results);

  const metadata: AgentEndReviewMetadata = {
    checkedFiles,
    skippedFiles,
    backendChecks: args.backendChecks.map((check) => ({
      ...check,
      files: uniqueSorted(check.files),
    })),
    issueCounts: counts,
    readiness,
  };

  if (metadata.backendChecks.length === 0 && args.results.length === 0) {
    return { summary: "", triggerTurn: false, metadata };
  }

  const lines = [
    "Post-edit checks completed.",
    `Checked: ${checkedFiles.length}${checkedFiles.length > 0 ? ` (${renderFileList(checkedFiles)})` : ""}`,
    `Backends: ${renderBackendChecks(metadata.backendChecks)}`,
  ];
  if (skippedFiles.length > 0) {
    lines.push(`Skipped unsupported/unavailable: ${skippedFiles.length} (${renderFileList(skippedFiles)})`);
  }
  lines.push(
    `Issues: ${counts.errors} error${counts.errors === 1 ? "" : "s"}, ${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`,
    REVIEW_INSTRUCTIONS[readiness],
  );
  if (issueSummary) lines.push("", issueSummary);

  return {
    summary: lines.join("\n"),
    triggerTurn: shouldTriggerTurn(args.results),
    metadata,
  };
}
