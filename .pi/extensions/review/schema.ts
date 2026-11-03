import { Type, type Static } from "typebox";

export const ReviewCommand = { Get: "get" } as const;
export type ReviewCommand = (typeof ReviewCommand)[keyof typeof ReviewCommand];

export const PrReviewFeedback = {
  All: "all",
  Conversation: "conversation",
  Reviews: "reviews",
  Inline: "inline",
} as const;
export type PrReviewFeedback = (typeof PrReviewFeedback)[keyof typeof PrReviewFeedback];

export const MAX_CONTEXT_PAGE_SIZE = 5;
export const PrReviewParamsSchema = Type.Object(
  {
    command: Type.Literal("pr"),
    action: Type.Literal(ReviewCommand.Get),
    url: Type.Optional(
      Type.String({
        description:
          "GitHub pull request URL. Omit to resolve the current checkout with gh pr view.",
      }),
    ),
    feedback: Type.Optional(
      Type.Enum(Object.values(PrReviewFeedback), {
        type: "string",
        description: "Feedback category. Defaults to all categories.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        maxLength: 4096,
        description: "Opaque pagination cursor returned by a prior review pr get result.",
      }),
    ),
    pageSize: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_CONTEXT_PAGE_SIZE,
        description: "Items per feedback category. Defaults to 3 and is capped at 5.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type PrReviewParams = Static<typeof PrReviewParamsSchema>;
