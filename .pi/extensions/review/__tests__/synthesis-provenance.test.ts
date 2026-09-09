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
function synthesis(
  rawFindingIds: string[],
  overrides: Partial<ConsolidationReviewV2> = {},
): ConsolidationReviewV2 {
  return {
    v: 2,
    verdict: "Editorial summary.",
    coverage: {
      status: "complete",
      succeeded: ["correctness", "security"],
      failed: [],
      malformed: [],
    },
    findings: [
      {
        ...finding,
        problem: "The grouped problem is clearer.",
        rawFindingIds,
      },
    ],
    dismissals: [],
    ...overrides,
  };
}

describe("provenance-backed editorial consolidation", () => {
  it("accepts a rephrased many-to-one group and preserves both original payloads", () => {
    const source = [
      reviewer("correctness", [finding]),
      reviewer("security", [{ ...finding, consequence: "Attackers can exploit the behavior." }]),
    ];
    const raw = buildRawFindingRecords(source);
    const result = consolidateSynthesis(
      synthesis(raw.map((record) => record.id)),
      raw,
    );

    expect(result?.findings[0]).toMatchObject({
      problem: "The grouped problem is clearer.",
      rawFindingIds: raw.map((record) => record.id),
      sourceReviewers: ["correctness", "security"],
      agreement: 2,
    });
    expect(result?.provenance?.rawFindings.map((record) => record.finding)).toEqual([
      finding,
      { ...finding, consequence: "Attackers can exploit the behavior." },
    ]);

    // Practical negative control: omission is not accepted as a silent subset.
    expect(consolidateSynthesis(synthesis([raw[0].id]), raw)).toBeUndefined();
  });

  it("derives agreement from distinct roles rather than raw occurrences or model claims", () => {
    const raw = buildRawFindingRecords([
      reviewer("correctness", [finding, { ...finding, problem: "A second problem." }]),
      reviewer("security", [{ ...finding, problem: "A security framing." }]),
    ]);
    const result = consolidateSynthesis(
      synthesis(raw.map((record) => record.id)),
      raw,
    );
    expect(result?.findings[0]).toMatchObject({
      sourceReviewers: ["correctness", "security"],
      agreement: 2,
    });
    expect(result?.findings[0]).not.toHaveProperty("dissent");

    const inflated = {
      ...synthesis(raw.map((record) => record.id)),
      findings: [
        {
          ...synthesis(raw.map((record) => record.id)).findings[0],
          sourceReviewers: ["correctness", "security", "tests"],
          agreement: 3,
        },
      ],
    } as unknown as ConsolidationReviewV2;
    const inflatedResult = consolidateSynthesis(inflated, raw);
    expect(inflatedResult?.findings[0]).toMatchObject({
      sourceReviewers: ["correctness", "security"],
      agreement: 2,
    });
  });

  it("requires every admitted raw ID exactly once across retention and dismissal", () => {
    const raw = buildRawFindingRecords([
      reviewer("correctness", [finding, { ...finding, problem: "Second." }]),
      reviewer("security", [{ ...finding, problem: "Third." }]),
    ]);
    const valid = synthesis([raw[0].id, raw[1].id], {
      dismissals: [{ rawFindingId: raw[2].id, reason: "Duplicate concern after inspection." }],
    });
    expect(consolidateSynthesis(valid, raw)?.provenance?.dismissals).toEqual(valid.dismissals);

    const mutations: ConsolidationReviewV2[] = [
      synthesis([raw[0].id, raw[1].id]),
      synthesis([raw[0].id, raw[1].id], {
        findings: [
          synthesis([raw[0].id]).findings[0],
          synthesis([raw[0].id, raw[1].id]).findings[0],
        ],
        dismissals: [{ rawFindingId: raw[2].id, reason: "Dismissed." }],
      }),
      synthesis([raw[0].id, raw[1].id], {
        dismissals: [
          { rawFindingId: raw[1].id, reason: "Also dismissed." },
          { rawFindingId: raw[2].id, reason: "Dismissed." },
        ],
      }),
      synthesis([raw[0].id, raw[1].id], {
        dismissals: [{ rawFindingId: raw[2].id, reason: "   " }],
      }),
      synthesis([raw[0].id, raw[1].id], {
        dismissals: [{ rawFindingId: `R-${"f".repeat(64)}`, reason: "Unknown." }],
      }),
    ];
    for (const mutation of mutations) expect(consolidateSynthesis(mutation, raw)).toBeUndefined();
  });

  it("assigns stable opaque IDs scoped to role, evidence, payload, and duplicate occurrence", () => {
    const duplicate = { ...finding };
    const first = [
      reviewer("correctness", [finding, duplicate]),
      reviewer("security", [finding]),
    ];
    const reordered = [first[1], first[0]];
    const ids = buildRawFindingRecords(first).map((record) => record.id);
    expect(buildRawFindingRecords(reordered).map((record) => record.id)).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
    expect(
      buildRawFindingRecords([{ ...first[0], evidenceDigest: "b".repeat(64) }])[0].id,
    ).not.toBe(ids[0]);
  });

  it("fallback preserves every identical admitted occurrence without deduplication", () => {
    const raw = buildRawFindingRecords([
      reviewer("correctness", [finding, finding]),
      reviewer("security", [finding]),
    ]);
    const result = fallbackConsolidation(raw, "Invalid accounting.");
    expect(result.findings).toHaveLength(3);
    expect(result.findings.flatMap((item) => item.rawFindingIds ?? [])).toEqual(
      raw.map((record) => record.id),
    );
    expect(result.provenance).toMatchObject({
      status: "fallback",
      fallbackReason: "Invalid accounting.",
    });
  });

  it("keeps the exact-text validator as an explicit legacy-only contract", () => {
    const reviewers = [reviewer("correctness", [finding]), reviewer("security", [finding])];
    const legacy: SynthesisReview = {
      verdict: "Historical summary.",
      coverage: {
        status: "complete",
        succeeded: ["correctness", "security"],
        failed: [],
        malformed: [],
      },
      findings: [{ ...finding, sourceReviewers: ["correctness", "security"], agreement: 2 }],
    };
    expect(validSynthesisSources(legacy, reviewers)).toBe(true);
    expect(validSynthesisSources({ ...legacy, findings: [] }, reviewers)).toBe(false);
  });
});
