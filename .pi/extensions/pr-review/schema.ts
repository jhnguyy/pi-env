import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const PrReviewAction = {
  Get: "get",
  Create: "create",
} as const;
export type PrReviewAction = (typeof PrReviewAction)[keyof typeof PrReviewAction];

export const PrReviewFeedback = {
  All: "all",
  Conversation: "conversation",
  Reviews: "reviews",
  Inline: "inline",
} as const;
export type PrReviewFeedback = (typeof PrReviewFeedback)[keyof typeof PrReviewFeedback];

const PR_REVIEW_ACTION_VALUES = [PrReviewAction.Get, PrReviewAction.Create] as const;
const PR_REVIEW_FEEDBACK_VALUES = [
  PrReviewFeedback.All,
  PrReviewFeedback.Conversation,
  PrReviewFeedback.Reviews,
  PrReviewFeedback.Inline,
] as const;

export const MAX_CONTEXT_PAGE_SIZE = 5;
export const PrReviewParamsSchema = Type.Object(
  {
    action: StringEnum(PR_REVIEW_ACTION_VALUES),
    url: Type.Optional(
      Type.String({
        description:
          "GitHub pull request URL. Omit to resolve the current checkout with gh pr view.",
      }),
    ),
    feedback: Type.Optional(
      StringEnum(PR_REVIEW_FEEDBACK_VALUES, {
        description: "Feedback category for action=get. Defaults to all categories.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        maxLength: 4096,
        description: "Opaque pagination cursor returned by a prior action=get result.",
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

export const REVIEW_TOOL_NAMES = [
  "review_read",
  "review_grep",
  "review_find",
  "review_list",
  "review_diff",
  "review_changed_files",
  "submit_review_plan",
  "submit_review",
] as const;
export const REVIEW_COMMANDS = [
  "start",
  "status",
  "findings",
  "select",
  "edit",
  "preface",
  "rerun",
  "post",
  "cleanup",
] as const;
export const ReviewEvent = {
  Comment: "COMMENT",
  Approve: "APPROVE",
  RequestChanges: "REQUEST_CHANGES",
} as const;
export type ReviewEvent = (typeof ReviewEvent)[keyof typeof ReviewEvent];
export const Severity = {
  Low: "low",
  Medium: "medium",
  Serious: "serious",
  Blocking: "blocking",
} as const;
export const Impact = { Low: "low", Medium: "medium", High: "high" } as const;
export const Side = { Left: "LEFT", Right: "RIGHT" } as const;
export const Attention = { Low: "low", Normal: "normal", High: "high" } as const;
export const MAX_PAGE_SIZE = 500;

const NonEmptyString = Type.String({
  minLength: 1,
  maxLength: 19999,
  pattern: "^(?=[\\s\\S]*\\S)[\\s\\S]+$",
});

export const PlanCohortSchema = Type.Object(
  {
    label: NonEmptyString,
    purpose: NonEmptyString,
    paths: Type.Array(NonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export const PlanFileSchema = Type.Object(
  {
    path: NonEmptyString,
    attention: StringEnum(Object.values(Attention) as [string, ...string[]]),
    role: NonEmptyString,
  },
  { additionalProperties: false },
);
export const PlanSchema = Type.Object(
  {
    goal: NonEmptyString,
    goalAssessment: NonEmptyString,
    risk: NonEmptyString,
    riskReasons: Type.Array(NonEmptyString, { maxItems: 50 }),
    cohorts: Type.Array(PlanCohortSchema, { minItems: 1, maxItems: 100 }),
    files: Type.Array(PlanFileSchema, { minItems: 1, maxItems: 100_000 }),
    rippleNotes: Type.Optional(Type.Array(NonEmptyString, { maxItems: 100 })),
  },
  { additionalProperties: false },
);
export const FindingInputSchema = Type.Object(
  {
    severity: StringEnum(Object.values(Severity) as [string, ...string[]]),
    impact: StringEnum(Object.values(Impact) as [string, ...string[]]),
    file: Type.Optional(NonEmptyString),
    side: Type.Optional(StringEnum(Object.values(Side) as [string, ...string[]])),
    line: Type.Optional(Type.Integer({ minimum: 1, maximum: 999999 })),
    problem: NonEmptyString,
    consequence: NonEmptyString,
    suggestedFix: NonEmptyString,
  },
  { additionalProperties: false },
);
export const ReviewSchema = Type.Object(
  {
    verdict: NonEmptyString,
    findings: Type.Array(FindingInputSchema, { maxItems: 1000 }),
  },
  { additionalProperties: false },
);
export const PathParamSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({ description: "Path relative to the managed review worktree." }),
    ),
  },
  { additionalProperties: false },
);
export const GrepParamSchema = Type.Object(
  { pattern: Type.String({ minLength: 1, maxLength: 200 }), path: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
export const DiffParamSchema = Type.Object(
  { path: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
export const ChangedFilesParamSchema = Type.Object(
  {
    page: Type.Integer({ minimum: 1 }),
    pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  },
  { additionalProperties: false },
);

export type PlanCohort = Static<typeof PlanCohortSchema>;
export type PlanFile = Static<typeof PlanFileSchema>;
export type ReviewPlan = Static<typeof PlanSchema>;
export type FindingInput = Static<typeof FindingInputSchema>;
export type Finding = Omit<FindingInput, "side"> & {
  side?: AnchorSide;
  id?: string;
  selected?: boolean;
  anchorValid?: boolean;
};
export interface ReviewResult {
  verdict: string;
  findings: Finding[];
}
export type AnchorSide = "LEFT" | "RIGHT";

export interface ChangedFile {
  path: string;
  added?: number;
  deleted?: number;
}
export interface ReviewMetadata {
  owner: string;
  repo: string;
  number: number;
  url: string;
  baseRef?: string;
  baseOid: string;
  headRef?: string;
  headOid: string;
  title?: string;
  body?: string;
  changedFiles: ChangedFile[];
}
export interface ReviewSnapshot {
  id: string;
  metadata: ReviewMetadata;
  artifactDir: string;
  worktree: string;
  diffPath: string;
  diffHash: string;
  createdAt: string;
  cache?: { repoDir: string; worktree: string };
}
export interface PostAttempt {
  id: string;
  event: ReviewEvent;
  marker: string;
  status: "pending" | "posted" | "uncertain";
  reviewId?: string;
  at: string;
  contentHash?: string;
}
export interface ReviewState {
  snapshot: ReviewSnapshot;
  plan?: ReviewPlan;
  result?: ReviewResult;
  selectedFindingIds: string[];
  preface?: string;
  child?: {
    sessionFile?: string;
    sessionName?: string;
    isError?: boolean;
    message?: string;
  };
  posts: PostAttempt[];
  cleaned?: boolean;
}

function coherentAnchor(f: FindingInput): boolean {
  const hasFile = f.file !== undefined;
  const hasSide = f.side !== undefined;
  const hasLine = f.line !== undefined;
  if (!hasFile) return !hasSide && !hasLine;
  return (!hasSide && !hasLine) || (hasSide && hasLine);
}

export function validatePlanShape(plan: unknown): plan is ReviewPlan {
  return Check(PlanSchema, plan);
}
export function validateReviewShape(result: unknown): result is ReviewResult {
  return Check(ReviewSchema, result) && result.findings.every(coherentAnchor);
}
