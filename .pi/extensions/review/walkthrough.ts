import { bound, type Finding, type ReviewState } from "./core";
import { decisionFor, isDegraded } from "./decision";
import { pinnedContext } from "./walkthrough-context";

function findingLine(state: ReviewState, finding: Finding): string {
  const decision = decisionFor(state, finding.id!);
  const recommendation = finding.selected ? " recommended" : "";
  const anchor = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "unanchored";
  return `${finding.id} [${decision.status}]${recommendation} ${anchor} - ${finding.problem}`;
}

export function walkthroughSummary(state: ReviewState, interactive: boolean): string {
  const findings = state.result?.findings ?? [];
  const anchored = findings.filter((finding) => finding.anchorValid && finding.file);
  const unanchored = findings.filter((finding) => !finding.anchorValid || !finding.file);
  const coverage = state.result?.coverage;
  const raw = (state.result as any)?.provenance;
  const lines = [
    `Walkthrough: ${state.snapshot.id}`,
    "Overview",
    pinnedContext(state),
    "Coverage",
    `Status: ${coverage?.status ?? state.dag?.status ?? "unavailable"}`,
    `Omissions: ${(coverage as any)?.omissions?.join(", ") || "none"}`,
    `Failed nodes: ${state.dag?.failedNodes?.join(", ") || "none"}`,
    `Malformed nodes: ${state.dag?.malformedNodes?.join(", ") || "none"}`,
    `Fallback: ${raw?.fallbackReason ?? (state.dag?.status === "degraded" ? "degraded review" : "none")}`,
    `Usage: ${state.metrics?.usage?.turns ?? 0} turns, ${state.metrics?.usage?.input ?? 0} input, ${state.metrics?.usage?.output ?? 0} output`,
    "Reading plan",
    state.plan ? `${state.plan.files.length} changed files planned` : "Unavailable",
    "Anchored findings",
    anchored.map((finding) => findingLine(state, finding)).join("\n") || "None",
    "Unanchored findings",
    unanchored.map((finding) => findingLine(state, finding)).join("\n") || "None",
    "Provenance and dispositions",
    raw ? bound(JSON.stringify(raw), 3000) : "Legacy provenance unavailable",
    "Human decisions",
    findings.map((finding) => findingLine(state, finding)).join("\n") || "None",
    "Finalize",
    isDegraded(state) ? `Degraded review acknowledgement: ${state.degradationAcknowledgement ? "recorded" : "required"}` : "Review is not degraded.",
    interactive ? `/review pr finalize ${state.snapshot.id}` : `Interactive decisions unavailable. Rerun: /review pr walkthrough ${state.snapshot.id}`,
  ];
  return bound(lines.join("\n"), 12000);
}
