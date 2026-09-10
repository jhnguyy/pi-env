import { createHash } from "node:crypto";
import {
  ReviewerRoles,
  type AdmittedRawFinding,
  type ConsolidationReviewV2,
  type Finding,
  type FindingInput,
  type RawFindingRecord,
  type ReviewArtifactReference,
  type ReviewResult,
  type ReviewerOutput,
  type SynthesisReview,
} from "./schema";

const roleOrder = new Map(ReviewerRoles.map((role, index) => [role, index]));

export function findingKey(finding: FindingInput): string {
  return JSON.stringify([
    finding.severity,
    finding.impact,
    finding.file,
    finding.side,
    finding.line,
    finding.problem,
    finding.consequence,
    finding.suggestedFix,
  ]);
}

interface AdmittedReviewer {
  readonly reviewer: ReviewerOutput;
  readonly reference: ReviewArtifactReference;
}

/** Assigns one stable, evidence-scoped ID and reviewer-artifact index to every occurrence. */
export function buildRawFindingRecords(
  reviewers: readonly AdmittedReviewer[],
): readonly AdmittedRawFinding[] {
  const records: AdmittedRawFinding[] = [];
  const ordered = [...reviewers].sort(
    (left, right) =>
      (roleOrder.get(left.reviewer.role) ?? Number.MAX_SAFE_INTEGER) -
      (roleOrder.get(right.reviewer.role) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const { reviewer, reference } of ordered) {
    const occurrences = new Map<string, number>();
    for (const [index, finding] of reviewer.findings.entries()) {
      const key = findingKey(finding);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            "pr-review-raw-finding-v2",
            reviewer.role,
            reviewer.evidenceDigest,
            key,
            occurrence,
          ]),
        )
        .digest("hex");
      records.push(
        Object.freeze({
          id: `R-${digest}`,
          role: reviewer.role,
          evidenceDigest: reviewer.evidenceDigest,
          index,
          artifact: Object.freeze({ ...reference }),
          finding: Object.freeze({ ...finding }),
        }),
      );
    }
  }
  return Object.freeze(records);
}

function rolesFor(
  rawFindingIds: readonly string[],
  rawById: ReadonlyMap<string, AdmittedRawFinding>,
): ReviewerOutput["role"][] {
  return [...new Set(rawFindingIds.map((id) => rawById.get(id)!.role))].sort(
    (left, right) => roleOrder.get(left)! - roleOrder.get(right)!,
  );
}

/** Validates membership and exactly-once accounting at the synthesis submission boundary. */
export function validConsolidationAccounting(
  synthesis: ConsolidationReviewV2,
  rawFindings: readonly AdmittedRawFinding[],
): boolean {
  const rawById = new Map(rawFindings.map((raw) => [raw.id, raw]));
  if (rawById.size !== rawFindings.length) return false;
  const accounted = new Set<string>();
  const admit = (id: string): boolean => {
    if (!rawById.has(id) || accounted.has(id)) return false;
    accounted.add(id);
    return true;
  };
  for (const finding of synthesis.findings) if (!finding.rawFindingIds.every(admit)) return false;
  for (const dismissal of synthesis.dismissals)
    if (dismissal.reason.trim().length === 0 || !admit(dismissal.rawFindingId)) return false;
  return accounted.size === rawById.size;
}

function durableRawFindings(rawFindings: readonly AdmittedRawFinding[]): RawFindingRecord[] {
  return rawFindings.map(({ finding: _finding, artifact, ...record }) => ({
    ...record,
    artifact: { ...artifact },
  }));
}

/** Derives authoritative provenance after exactly-once accounting. */
export function consolidateSynthesis(
  synthesis: ConsolidationReviewV2,
  rawFindings: readonly AdmittedRawFinding[],
): ReviewResult | undefined {
  const rawById = new Map(rawFindings.map((raw) => [raw.id, raw]));
  if (!validConsolidationAccounting(synthesis, rawFindings)) return undefined;
  return {
    verdict: synthesis.verdict,
    coverage: synthesis.coverage,
    findings: synthesis.findings.map((finding) => {
      const { rawFindingIds, ...editorialFinding } = finding;
      const sources = rolesFor(rawFindingIds, rawById);
      return {
        ...editorialFinding,
        rawFindingIds: [...rawFindingIds],
        sourceReviewers: sources,
        agreement: sources.length,
      } as Finding;
    }),
    provenance: {
      v: 2,
      kind: "editorial-consolidation",
      status: "accepted",
      rawFindings: durableRawFindings(rawFindings),
      dismissals: synthesis.dismissals.map((dismissal) => ({ ...dismissal })),
    },
  };
}

/** Truthful fallback retains every admitted occurrence as its own finding. */
export function fallbackConsolidation(
  rawFindings: readonly AdmittedRawFinding[],
  reason: string,
): ReviewResult {
  return {
    verdict: `Reviewer consolidation failed. Every admitted raw finding is preserved below. ${reason}`,
    findings: rawFindings.map(
      (raw) =>
        ({
          ...raw.finding,
          rawFindingIds: [raw.id],
          sourceReviewers: [raw.role],
          agreement: 1,
        }) as Finding,
    ),
    coverage: { status: "degraded", succeeded: [], failed: [], malformed: [] },
    provenance: {
      v: 2,
      kind: "editorial-consolidation",
      status: "fallback",
      fallbackReason: reason,
      rawFindings: durableRawFindings(rawFindings),
      dismissals: [],
    },
  };
}

function findingInputFromLegacySynthesis(
  finding: SynthesisReview["findings"][number],
): FindingInput {
  const { sourceReviewers: _sourceReviewers, agreement: _agreement, ...input } = finding;
  return input;
}

function expectedLegacySources(
  reviewers: readonly ReviewerOutput[],
): Map<string, Set<ReviewerOutput["role"]>> {
  const expected = new Map<string, Set<ReviewerOutput["role"]>>();
  for (const reviewer of reviewers) {
    for (const finding of reviewer.findings) {
      const key = findingKey(finding);
      const sources = expected.get(key) ?? new Set();
      sources.add(reviewer.role);
      expected.set(key, sources);
    }
  }
  return expected;
}

/** Historical exact-text validator. New review runs never submit this format. */
export function validSynthesisSources(
  synthesis: SynthesisReview,
  reviewers: readonly ReviewerOutput[],
): boolean {
  const expected = expectedLegacySources(reviewers);
  const synthesizedKeys = new Set<string>();
  for (const finding of synthesis.findings) {
    const key = findingKey(findingInputFromLegacySynthesis(finding));
    const sources = expected.get(key);
    if (!sources || synthesizedKeys.has(key)) return false;
    if (
      finding.agreement !== sources.size ||
      finding.sourceReviewers.length !== sources.size ||
      !finding.sourceReviewers.every((role) => sources.has(role))
    )
      return false;
    synthesizedKeys.add(key);
  }
  return synthesizedKeys.size === expected.size;
}
