import type { Finding, ReviewState } from "./core";
import type { HumanDecision, HumanDecisionStatus } from "./schema";

export function decisionFor(state: ReviewState, findingId: string): HumanDecision {
  return state.decisions?.[findingId] ?? { status: "pending", at: "" };
}

export function selectedFindings(state: ReviewState): Finding[] {
  const legacyIds = new Set(state.selectedFindingIds);
  return (state.result?.findings ?? []).filter((finding) =>
    state.decisions === undefined
      ? legacyIds.has(finding.id!)
      : decisionFor(state, finding.id!).status === "selected",
  );
}

export function applyDecision(
  state: ReviewState,
  findingIds: readonly string[],
  status: Exclude<HumanDecisionStatus, "pending">,
  at = new Date().toISOString(),
): ReviewState {
  const known = new Set((state.result?.findings ?? []).map((finding) => finding.id));
  const invalid = findingIds.find((id) => !known.has(id));
  if (invalid) throw new Error(`Finding ${invalid} is not owned by review ${state.snapshot.id}.`);
  const decisions = { ...(state.decisions ?? {}) };
  for (const id of findingIds) decisions[id] = { status, at };
  const next = { ...state, decisions };
  return { ...next, selectedFindingIds: selectedFindings(next).map((finding) => finding.id!) };
}

export function isDegraded(state: ReviewState): boolean {
  const dagStatus = state.dag?.status;
  return (
    state.preparation?.status === "failed" ||
    dagStatus === "degraded" ||
    dagStatus === "failed" ||
    dagStatus === "cancelled" ||
    dagStatus === "interrupted" ||
    state.result?.coverage?.status === "degraded" ||
    Boolean(state.result?.coverage?.failed.length) ||
    Boolean(state.result?.coverage?.malformed.length) ||
    Boolean(state.dag?.failedNodes?.length) ||
    Boolean(state.dag?.malformedNodes?.length) ||
    Boolean(state.dag?.evidenceCoverage?.omissions.length) ||
    Boolean(state.plan?.evidenceOmissions?.length) ||
    state.result?.provenance?.status === "fallback"
  );
}
