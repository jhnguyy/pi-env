import { describe, expect, it } from "vitest";
import { validSynthesisSources } from "../synthesis-provenance";
import type { FindingInput, ReviewerOutput, SynthesisReview } from "../schema";

const finding: FindingInput = {
  severity: "serious",
  impact: "high",
  problem: "A problem exists.",
  consequence: "The behavior is unsafe.",
  suggestedFix: "Fix the behavior.",
};
const reviewers: ReviewerOutput[] = [
  {
    role: "correctness",
    evidenceDigest: "a".repeat(64),
    verdict: "Issue found.",
    findings: [finding],
  },
  {
    role: "security",
    evidenceDigest: "a".repeat(64),
    verdict: "Issue found.",
    findings: [finding],
  },
];
function synthesis(overrides: Partial<SynthesisReview> = {}): SynthesisReview {
  return {
    verdict: "Issue found.",
    coverage: {
      status: "complete",
      succeeded: ["correctness", "security"],
      failed: [],
      malformed: [],
    },
    findings: [
      {
        ...finding,
        sourceReviewers: ["correctness", "security"],
        agreement: 2,
      },
    ],
    ...overrides,
  };
}

describe("synthesis provenance", () => {
  it("requires every reviewer finding and the complete matching source set", () => {
    expect(validSynthesisSources(synthesis(), reviewers)).toBe(true);
    expect(validSynthesisSources(synthesis({ findings: [] }), reviewers)).toBe(false);
    expect(
      validSynthesisSources(
        synthesis({
          findings: [
            {
              ...finding,
              sourceReviewers: ["correctness"],
              agreement: 1,
            },
          ],
        }),
        reviewers,
      ),
    ).toBe(false);
    expect(
      validSynthesisSources(
        synthesis({
          findings: [
            {
              ...finding,
              sourceReviewers: ["correctness", "correctness"],
              agreement: 2,
            },
          ],
        }),
        reviewers,
      ),
    ).toBe(false);
  });
});
