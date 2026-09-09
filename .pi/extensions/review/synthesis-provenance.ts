import { createHash } from "node:crypto";
import {
  ReviewerRoles,
  type AdmittedRawFinding,
  type ConsolidationReviewV2,
  type Finding,
  type FindingInput,
  type RawFindingRecord,
  type ReviewResult,
  type ReviewerOutput,
  type SynthesisReview,
  validateRawFindingRecordShape,
} from "./schema";

const MaxRawFindingArtifactBytes = 262_144;
const RawFindingDirectory = "raw-provenance-v2";
const RawFindingProducer = "pr-review-raw-provenance-v2";
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

function copyFinding(finding: FindingInput): FindingInput {
  return Object.freeze({ ...finding });
}

/** Assigns one stable, evidence-scoped ID to every admitted raw occurrence. */
export function buildRawFindingRecords(
  reviewers: readonly ReviewerOutput[],
): readonly AdmittedRawFinding[] {
  const records: AdmittedRawFinding[] = [];
  const ordered = [...reviewers].sort(
    (left, right) =>
      (roleOrder.get(left.role) ?? Number.MAX_SAFE_INTEGER) -
      (roleOrder.get(right.role) ?? Number.MAX_SAFE_INTEGER),
  );
  for (const reviewer of ordered) {
    const occurrences = new Map<string, number>();
    for (const finding of reviewer.findings) {
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
          finding: copyFinding(finding),
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
  for (const finding of synthesis.findings) {
    if (!finding.rawFindingIds.every(admit)) return false;
  }
  for (const dismissal of synthesis.dismissals) {
    if (dismissal.reason.trim().length === 0 || !admit(dismissal.rawFindingId)) return false;
  }
  return accounted.size === rawById.size;
}

function validProvenanceRecord(
  record: RawFindingRecord,
  raw: AdmittedRawFinding | undefined,
  runId: string,
): boolean {
  if (!validateRawFindingRecordShape(record) || !raw) return false;
  const artifact = record.artifact;
  const validRawIdentity = raw.role === record.role && raw.evidenceDigest === record.evidenceDigest;
  const validArtifactIdentity =
    artifact.runId === runId &&
    artifact.producerNodeId === RawFindingProducer &&
    artifact.outputName === record.id &&
    artifact.path === `${RawFindingDirectory}/${record.id}.json`;
  return validRawIdentity && validArtifactIdentity && artifact.bytes <= MaxRawFindingArtifactBytes;
}

function validProvenanceRecordSet(
  rawFindings: readonly AdmittedRawFinding[],
  provenanceRecords: readonly RawFindingRecord[],
  runId: string,
): boolean {
  const rawById = new Map(rawFindings.map((raw) => [raw.id, raw]));
  if (
    runId.length === 0 ||
    rawById.size !== rawFindings.length ||
    provenanceRecords.length !== rawById.size
  )
    return false;
  const recordIds = new Set<string>();
  for (const record of provenanceRecords) {
    if (recordIds.has(record.id) || !validProvenanceRecord(record, rawById.get(record.id), runId))
      return false;
    recordIds.add(record.id);
  }
  return recordIds.size === rawById.size;
}

/** Derives authoritative provenance after valid accounting and artifact persistence. */
export function consolidateSynthesis(
  synthesis: ConsolidationReviewV2,
  rawFindings: readonly AdmittedRawFinding[],
  provenanceRecords: readonly RawFindingRecord[],
  runId: string,
): ReviewResult | undefined {
  const rawById = new Map(rawFindings.map((raw) => [raw.id, raw]));
  if (
    !validConsolidationAccounting(synthesis, rawFindings) ||
    !validProvenanceRecordSet(rawFindings, provenanceRecords, runId)
  )
    return undefined;

  const findings: Finding[] = synthesis.findings.map((finding) => {
    const { rawFindingIds, ...editorialFinding } = finding;
    const sources = rolesFor(rawFindingIds, rawById);
    return {
      ...editorialFinding,
      rawFindingIds: [...rawFindingIds],
      sourceReviewers: sources,
      agreement: sources.length,
    } as Finding;
  });
  return {
    verdict: synthesis.verdict,
    coverage: synthesis.coverage,
    findings,
    provenance: {
      v: 2,
      kind: "editorial-consolidation",
      status: "accepted",
      rawFindings: provenanceRecords.map((record) => ({
        ...record,
        artifact: { ...record.artifact },
      })),
      dismissals: synthesis.dismissals.map((dismissal) => ({ ...dismissal })),
    },
  };
}

/** Truthful fallback retains every admitted occurrence as its own finding. */
export function fallbackConsolidation(
  rawFindings: readonly AdmittedRawFinding[],
  provenanceRecords: readonly RawFindingRecord[],
  runId: string,
  reason: string,
): ReviewResult | undefined {
  if (!validProvenanceRecordSet(rawFindings, provenanceRecords, runId)) return undefined;
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
      rawFindings: provenanceRecords.map((record) => ({
        ...record,
        artifact: { ...record.artifact },
      })),
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
