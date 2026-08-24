import { getSupportedThinkingLevels, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";

export const PR_REVIEW_APPROVAL_ANNOTATION = "reviewer";
export const REVIEW_ROLE_NAMES = [
  "reading-plan",
  "correctness",
  "intent",
  "maintainability",
  "tests",
  "security",
  "whole-change",
  "synthesis",
] as const;
export type ReviewRoleName = (typeof REVIEW_ROLE_NAMES)[number];
export type ReviewFocusedRoleName = Extract<
  ReviewRoleName,
  "correctness" | "intent" | "maintainability" | "tests" | "security"
>;
export type ReviewRolePins = Partial<Record<ReviewRoleName, string>>;

export interface AgentSettingsLike {
  readonly modelAnnotations?: Readonly<Record<string, readonly string[]>>;
}
export interface ReviewModelCandidate {
  readonly provider: string;
  readonly model: string;
  readonly reasoning?: ThinkingLevel;
  readonly fqid: string;
}
export interface ReviewModelAssignment extends ReviewModelCandidate {
  readonly role: ReviewRoleName;
  readonly pinned: boolean;
}
export interface ReviewModelPolicySuccess {
  readonly ok: true;
  readonly approvedRoster: readonly ReviewModelCandidate[];
  readonly assignments: Readonly<Record<ReviewRoleName, ReviewModelAssignment>>;
}
export type ReviewModelPolicyErrorCode =
  | "no_approved_models"
  | "invalid_pin"
  | "unapproved_model"
  | "provider_diversity_required";
export class ReviewModelPolicyError extends Error {
  constructor(
    readonly code: ReviewModelPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewModelPolicyError";
  }
}

const FocusedRoles: readonly ReviewFocusedRoleName[] = [
  "correctness",
  "intent",
  "maintainability",
  "tests",
  "security",
];
type ReviewModel = Model<any>;

function fqid(model: Pick<ReviewModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}
function highestReasoning(model: ReviewModel): ThinkingLevel | undefined {
  const supported = getSupportedThinkingLevels(model);
  for (let index = supported.length - 1; index >= 0; index -= 1) {
    const level = supported[index];
    if (level && level !== "off") return level;
  }
  return undefined;
}
function compare(left: ReviewModelCandidate, right: ReviewModelCandidate): number {
  return left.fqid.localeCompare(right.fqid);
}
function assignment(
  role: ReviewRoleName,
  candidate: ReviewModelCandidate,
  pinned: boolean,
): ReviewModelAssignment {
  return Object.freeze({ role, ...candidate, pinned });
}

export function resolvePrReviewModelPolicy(
  settings: AgentSettingsLike,
  availableModels: readonly ReviewModel[],
  pins: ReviewRolePins | Readonly<Record<string, string>> = {},
): ReviewModelPolicySuccess {
  for (const role of Object.keys(pins)) {
    if (!REVIEW_ROLE_NAMES.some((known) => known === role))
      throw new ReviewModelPolicyError("invalid_pin", `Unknown PR review role pin: ${role}.`);
  }
  const availableById = new Map(availableModels.map((model) => [fqid(model), model] as const));
  const approvedRoster = availableModels
    .filter((model) =>
      settings.modelAnnotations?.[fqid(model)]?.includes(PR_REVIEW_APPROVAL_ANNOTATION),
    )
    .map((model) => ({
      provider: model.provider,
      model: model.id,
      fqid: fqid(model),
      reasoning: highestReasoning(model),
    }))
    .sort(compare);
  if (approvedRoster.length === 0)
    throw new ReviewModelPolicyError(
      "no_approved_models",
      "No available model has the exact reviewer approval annotation.",
    );
  const approvedById = new Map(approvedRoster.map((candidate) => [candidate.fqid, candidate]));
  for (const role of REVIEW_ROLE_NAMES) {
    const pin = pins[role];
    if (!pin) continue;
    if (!availableById.has(pin))
      throw new ReviewModelPolicyError(
        "invalid_pin",
        `Pinned role ${role} references unavailable model ${pin}.`,
      );
    if (!approvedById.has(pin))
      throw new ReviewModelPolicyError(
        "unapproved_model",
        `Pinned role ${role} references model ${pin} without reviewer approval.`,
      );
  }
  const providers = [...new Set(approvedRoster.map((candidate) => candidate.provider))];
  if (providers.length < 2)
    throw new ReviewModelPolicyError(
      "provider_diversity_required",
      "PR review requires approved models from at least two providers.",
    );
  const assignments = {} as Record<ReviewRoleName, ReviewModelAssignment>;
  const choose = (role: ReviewRoleName, fallbackIndex: number): ReviewModelAssignment => {
    const pin = pins[role];
    const candidate = pin
      ? approvedById.get(pin)
      : approvedRoster[fallbackIndex % approvedRoster.length];
    if (!candidate)
      throw new ReviewModelPolicyError(
        "no_approved_models",
        "No approved model is available for the requested review role.",
      );
    return assignment(role, candidate, pin !== undefined);
  };
  assignments["reading-plan"] = choose("reading-plan", 0);
  FocusedRoles.forEach((role, index) => {
    const provider = providers[index % providers.length];
    const fallback = approvedRoster.findIndex((candidate) => candidate.provider === provider);
    assignments[role] = choose(role, fallback < 0 ? index : fallback);
  });
  if (pins["whole-change"]) assignments["whole-change"] = choose("whole-change", 1);
  else {
    const baselineProvider = assignments.correctness.provider;
    const candidate = approvedRoster.find((item) => item.provider !== baselineProvider)!;
    assignments["whole-change"] = assignment("whole-change", candidate, false);
  }
  if (
    FocusedRoles.every(
      (role) => assignments[role].provider === assignments["whole-change"].provider,
    )
  )
    throw new ReviewModelPolicyError(
      "provider_diversity_required",
      "The whole-change reviewer must differ from at least one focused reviewer provider.",
    );
  assignments.synthesis = choose(
    "synthesis",
    approvedRoster.indexOf(approvedById.get(assignments["whole-change"].fqid)!),
  );
  return Object.freeze({
    ok: true,
    approvedRoster: Object.freeze(approvedRoster),
    assignments: Object.freeze(assignments),
  });
}
