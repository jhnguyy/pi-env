import type { FindingInput, ReviewerOutput, SynthesisReview } from "./schema";

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

function findingInputFromSynthesis(
  finding: SynthesisReview["findings"][number],
): FindingInput {
  const { sourceReviewers: _sourceReviewers, agreement: _agreement, ...input } = finding;
  return input;
}

export function validSynthesisSources(
  synthesis: SynthesisReview,
  reviewers: readonly ReviewerOutput[],
): boolean {
  const reviewerByRole = new Map(reviewers.map((reviewer) => [reviewer.role, reviewer]));
  return synthesis.findings.every((finding) => {
    const uniqueSources = new Set(finding.sourceReviewers);
    const input = findingInputFromSynthesis(finding);
    return (
      finding.sourceReviewers.length === uniqueSources.size &&
      finding.agreement === uniqueSources.size &&
      finding.sourceReviewers.every((role) =>
        reviewerByRole
          .get(role)
          ?.findings.some((candidate) => findingKey(candidate) === findingKey(input)),
      )
    );
  });
}
