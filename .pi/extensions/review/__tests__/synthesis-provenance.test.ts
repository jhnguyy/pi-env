import { describe, expect, it } from "vitest";
import {
  buildRawFindingRecords,
  consolidateSynthesis,
  fallbackConsolidation,
  validSynthesisSources,
} from "../synthesis-provenance";
import type {
  ConsolidationReviewV2,
  FindingInput,
  ReviewerOutput,
  SynthesisReview,
} from "../schema";

const Digest = "a".repeat(64);
const finding: FindingInput = {
  severity: "serious",
  impact: "high",
  problem: "A problem exists.",
  consequence: "The behavior is unsafe.",
  suggestedFix: "Fix the behavior.",
};
function reviewer(role: ReviewerOutput["role"], findings: FindingInput[]): ReviewerOutput {
  return { role, evidenceDigest: Digest, verdict: "Reviewed.", findings };
}
function admitted(reviewers: ReviewerOutput[]) {
  return reviewers.map((reviewer) => ({
    reviewer,
    reference: {
      v: 1 as const,
      path: `${reviewer.role}.json`,
      bytes: 100,
      digest: "b".repeat(64),
      runId: "run",
      producerNodeId: `review-${reviewer.role}`,
      outputName: `${reviewer.role.replace("-", "_")}_review`,
    },
  }));
}
function synthesis(rawFindingIds: string[], dismissals: ConsolidationReviewV2["dismissals"] = []) {
  return {
    v: 2 as const,
    verdict: "Editorial summary.",
    coverage: { status: "complete" as const, succeeded: [], failed: [], malformed: [] },
    findings: [{ ...finding, problem: "Grouped problem.", rawFindingIds }],
    dismissals,
  };
}

describe("provenance-backed editorial consolidation", () => {
  it("stores existing reviewer references and derives agreement without copying payloads", () => {
    const raw = buildRawFindingRecords(
      admitted([
        reviewer("correctness", [finding]),
        reviewer("security", [{ ...finding, problem: "Security framing." }]),
      ]),
    );
    const result = consolidateSynthesis(
      synthesis(raw.map((record) => record.id)),
      raw,
    );
    expect(result?.findings[0]).toMatchObject({
      problem: "Grouped problem.",
      sourceReviewers: ["correctness", "security"],
      agreement: 2,
    });
    expect(result?.provenance?.rawFindings).toEqual(
      raw.map(({ finding: _finding, ...record }) => record),
    );
    expect(result?.provenance?.rawFindings[0]).toMatchObject({ index: 0 });
    expect(result?.provenance?.rawFindings[0]).not.toHaveProperty("finding");
  });

  it("requires every admitted occurrence exactly once across findings and dismissals", () => {
    const raw = buildRawFindingRecords(
      admitted([reviewer("correctness", [finding, { ...finding, problem: "Second." }])]),
    );
    expect(
      consolidateSynthesis(
        synthesis([raw[0].id], [{ rawFindingId: raw[1].id, reason: "Not actionable." }]),
        raw,
      )?.provenance?.dismissals,
    ).toHaveLength(1);
    expect(consolidateSynthesis(synthesis([raw[0].id]), raw)).toBeUndefined();
    expect(consolidateSynthesis(synthesis([raw[0].id, raw[0].id]), raw)).toBeUndefined();
  });

  it("assigns stable distinct IDs and indexes to duplicate occurrences", () => {
    const source = reviewer("correctness", [finding, finding]);
    const raw = buildRawFindingRecords(admitted([source]));
    expect(raw.map((record) => record.index)).toEqual([0, 1]);
    expect(new Set(raw.map((record) => record.id)).size).toBe(2);
    expect(
      buildRawFindingRecords(admitted([{ ...source, evidenceDigest: "c".repeat(64) }]))[0].id,
    ).not.toBe(raw[0].id);
  });

  it("fallback preserves every occurrence without deduplication", () => {
    const raw = buildRawFindingRecords(
      admitted([reviewer("correctness", [finding, finding]), reviewer("security", [finding])]),
    );
    const result = fallbackConsolidation(raw, "Invalid accounting.");
    expect(result.findings).toHaveLength(3);
    expect(result.findings.flatMap((item) => item.rawFindingIds ?? [])).toEqual(
      raw.map((record) => record.id),
    );
    expect(result.provenance?.status).toBe("fallback");
  });

  it("keeps the exact-text validator as a legacy-only contract", () => {
    const reviewers = [reviewer("correctness", [finding]), reviewer("security", [finding])];
    const legacy: SynthesisReview = {
      verdict: "Historical summary.",
      coverage: { status: "complete", succeeded: [], failed: [], malformed: [] },
      findings: [{ ...finding, sourceReviewers: ["correctness", "security"], agreement: 2 }],
    };
    expect(validSynthesisSources(legacy, reviewers)).toBe(true);
    expect(validSynthesisSources({ ...legacy, findings: [] }, reviewers)).toBe(false);
  });
});
