export const ReviewNodes = Object.freeze([
  { role: "reading-plan", nodeId: "reading-plan", outputName: "reading_plan", kind: "plan" },
  {
    role: "correctness",
    nodeId: "review-correctness",
    outputName: "correctness_review",
    kind: "focused-reviewer",
  },
  {
    role: "intent",
    nodeId: "review-intent",
    outputName: "intent_review",
    kind: "focused-reviewer",
  },
  {
    role: "maintainability",
    nodeId: "review-maintainability",
    outputName: "maintainability_review",
    kind: "focused-reviewer",
  },
  {
    role: "tests",
    nodeId: "review-tests",
    outputName: "tests_review",
    kind: "focused-reviewer",
  },
  {
    role: "security",
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
export const EvidenceResolverNode = Object.freeze({
  nodeId: "evidence-resolver",
  outputName: "evidence_coverage",
  kind: "evidence-resolver",
} as const);
export const SynthesisNode = requiredReviewNode("synthesis");
export const ReviewerNodes = Object.freeze(
  ReviewNodes.filter(
    (node) => node.kind === "focused-reviewer" || node.kind === "whole-change-reviewer",
  ),
);
