import { sha256, type Finding, type ReviewState } from "./core";
import type { HumanDecision, HumanDecisionStatus } from "./schema";

export const DECISION_STATUSES = ["pending", "selected", "rejected", "deferred"] as const;

export function decisionFor(state: ReviewState, findingId: string): HumanDecision {
  return state.decisions?.[findingId] ?? { status: "pending", at: "" };
}

export function isDecisionEnabled(state: ReviewState): boolean {
  return state.decisions !== undefined;
}

export function findingsForDecision(state: ReviewState, status?: HumanDecisionStatus): Finding[] {
  return (state.result?.findings ?? []).filter((finding) => {
    const decision = decisionFor(state, finding.id!);
    return status === undefined ? decision.status === "selected" : decision.status === status;
  });
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
  return { ...state, decisions };
}

export function degradationHash(state: ReviewState): string {
  return sha256(JSON.stringify({
    head: state.snapshot.metadata.headOid,
    coverage: state.result?.coverage,
    dag: {
      status: state.dag?.status,
      failedNodes: state.dag?.failedNodes,
      malformedNodes: state.dag?.malformedNodes,
      error: state.dag?.error,
    },
  }));
}

export function contentHash(state: ReviewState): string {
  return sha256(JSON.stringify({
    reviewId: state.snapshot.id,
    head: state.snapshot.metadata.headOid,
    findings: state.result?.findings,
    raw: (state.result as any)?.provenance,
  }));
}

export function isDegraded(state: ReviewState): boolean {
  return state.dag?.status === "degraded" || state.result?.coverage?.status === "degraded" ||
    Boolean(state.dag?.failedNodes?.length || state.dag?.malformedNodes?.length || (state.result?.coverage as any)?.omissions?.length);
}

export function hasCurrentAcknowledgement(state: ReviewState): boolean {
  const acknowledgement = state.degradationAcknowledgement;
  return Boolean(acknowledgement && acknowledgement.contentHash === contentHash(state) && acknowledgement.degradationHash === degradationHash(state));
}
