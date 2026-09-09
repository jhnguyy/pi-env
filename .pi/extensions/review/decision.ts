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
  const selectedFindingIds = (state.result?.findings ?? []).flatMap((finding) =>
    finding.id && decisions[finding.id]?.status === "selected" ? [finding.id] : [],
  );
  return { ...state, decisions, selectedFindingIds };
}

export function degradationHash(state: ReviewState): string {
  return sha256(
    JSON.stringify({
      head: state.snapshot.metadata.headOid,
      preparation: state.preparation,
      coverage: state.result?.coverage,
      evidenceOmissions: state.dag?.evidenceCoverage?.omissions ?? state.plan?.evidenceOmissions ?? [],
      provenanceFallback: state.result?.provenance?.status === "fallback"
        ? state.result.provenance.fallbackReason ?? "fallback"
        : undefined,
      dag: {
        status: state.dag?.status,
        failedNodes: state.dag?.failedNodes,
        malformedNodes: state.dag?.malformedNodes,
        error: state.dag?.error,
      },
    }),
  );
}

export function contentHash(state: ReviewState): string {
  return sha256(
    JSON.stringify({
      reviewId: state.snapshot.id,
      head: state.snapshot.metadata.headOid,
      diffHash: state.snapshot.diffHash,
      findings: state.result?.findings,
      provenance: state.result?.provenance,
      decisions: state.decisions,
      selectedFindingIds: state.selectedFindingIds,
      preface: state.preface,
      evidenceOmissions: state.dag?.evidenceCoverage?.omissions ?? state.plan?.evidenceOmissions ?? [],
    }),
  );
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

export function hasCurrentAcknowledgement(state: ReviewState): boolean {
  const acknowledgement = state.degradationAcknowledgement;
  return Boolean(
    acknowledgement &&
      acknowledgement.contentHash === contentHash(state) &&
      acknowledgement.degradationHash === degradationHash(state),
  );
}
