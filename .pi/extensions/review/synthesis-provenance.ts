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

function expectedSources(reviewers: readonly ReviewerOutput[]): Map<string, Set<ReviewerOutput["role"]>> {
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

function sameSources(
  actual: readonly ReviewerOutput["role"][],
  expected: ReadonlySet<ReviewerOutput["role"]>,
): boolean {
  return actual.length === expected.size && actual.every((role) => expected.has(role));
}

export function validSynthesisSources(
  synthesis: SynthesisReview,
  reviewers: readonly ReviewerOutput[],
): boolean {
  const expected = expectedSources(reviewers);
  const synthesizedKeys = new Set<string>();
  for (const finding of synthesis.findings) {
    const key = findingKey(findingInputFromSynthesis(finding));
    const sources = expected.get(key);
    if (!sources || synthesizedKeys.has(key)) return false;
    if (finding.agreement !== sources.size || !sameSources(finding.sourceReviewers, sources))
      return false;
    synthesizedKeys.add(key);
  }
  return synthesizedKeys.size === expected.size;
}
