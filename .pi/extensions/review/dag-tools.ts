import { createHash } from "node:crypto";
import type { ReviewGraphToolNames } from "./review-graph";

export { readVerifiedReviewArtifact } from "./reviewer-dossier";

/** Names are data; executable review authority is constructed only by the service. */
export function reviewDagToolNames(reviewId: string): ReviewGraphToolNames {
  const suffix = createHash("sha256").update(reviewId).digest("hex").slice(0, 12);
  return {
    deck: `review_deck_${suffix}`,
    read: ["review_metadata", "review_read", "review_list", "review_find", "review_grep", "review_diff", "review_changed_files"].map(
      (name) => `${name}_${suffix}`,
    ),
    planSubmission: `submit_review_plan_${suffix}`,
    resultReferences: `review_result_refs_${suffix}`,
    synthesisSubmission: `submit_review_synthesis_${suffix}`,
  };
}
