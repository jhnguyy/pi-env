export const ReviewDimension = {
  Correctness: "correctness",
  Intent: "intent",
  Maintainability: "maintainability",
  Tests: "tests",
  Security: "security",
} as const;
export type ReviewDimension = (typeof ReviewDimension)[keyof typeof ReviewDimension];

export const ReviewNodes = Object.freeze([
  { role: "reading-plan", nodeId: "reading-plan", outputName: "reading_plan", kind: "plan" },
  {
    role: ReviewDimension.Correctness,
    nodeId: "review-correctness",
    outputName: "correctness_review",
    kind: "focused-reviewer",
  },
  {
    role: ReviewDimension.Intent,
    nodeId: "review-intent",
    outputName: "intent_review",
    kind: "focused-reviewer",
  },
  {
    role: ReviewDimension.Maintainability,
    nodeId: "review-maintainability",
    outputName: "maintainability_review",
    kind: "focused-reviewer",
  },
  {
    role: ReviewDimension.Tests,
    nodeId: "review-tests",
    outputName: "tests_review",
    kind: "focused-reviewer",
  },
  {
    role: ReviewDimension.Security,
    nodeId: "review-security",
    outputName: "security_review",
    kind: "focused-reviewer",
  },
  {
    role: "whole-change",
    nodeId: "review-whole-change",
    outputName: "whole_change_review",
    kind: "whole-change-reviewer",
  },
  { role: "synthesis", nodeId: "synthesis", outputName: "synthesis", kind: "synthesis" },
] as const);

export type ReviewNode = (typeof ReviewNodes)[number];
export type ReviewRole = ReviewNode["role"];
export const ReviewRoles = Object.freeze(ReviewNodes.map((node) => node.role));
export const FocusedReviewRoles = Object.freeze(
  ReviewNodes.filter((node) => node.kind === "focused-reviewer").map((node) => node.role),
);
function requiredReviewNode(role: ReviewRole): ReviewNode {
  const node = ReviewNodes.find((candidate) => candidate.role === role);
  if (!node) throw new Error(`Missing PR review topology node for ${role}.`);
  return node;
}
export const ReadingPlanNode = requiredReviewNode("reading-plan");
export const SynthesisNode = requiredReviewNode("synthesis");
export const ReviewFanoutNodes = Object.freeze(
  ReviewNodes.filter((node) => node.kind !== "synthesis"),
);
export const ReviewerNodes = Object.freeze(
  ReviewNodes.filter(
    (node) => node.kind === "focused-reviewer" || node.kind === "whole-change-reviewer",
  ),
);
