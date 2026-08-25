import { getSupportedThinkingLevels, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import {
  FocusedReviewRoles,
  ReviewRoles,
  type ReviewRole,
} from "./review-topology";

export const PR_REVIEW_APPROVAL_ANNOTATION = "reviewer";
export type ReviewRolePins = Partial<Record<ReviewRole, string>>;

export interface AgentSettingsLike {
  readonly modelAnnotations?: Readonly<Record<string, readonly string[]>>;
}
export interface ReviewModelCandidate {
  readonly provider: string;
  readonly model: string;
  readonly reasoning?: ThinkingLevel;
  readonly fqid: string;
  readonly contextWindow: number;
}
export interface ReviewModelAssignment extends ReviewModelCandidate {
  readonly role: ReviewRole;
  readonly pinned: boolean;
}
export interface ReviewModelPolicySuccess {
  readonly ok: true;
  readonly approvedRoster: readonly ReviewModelCandidate[];
  readonly assignments: Readonly<Record<ReviewRole, ReviewModelAssignment>>;
}
export type ReviewModelPolicyErrorCode = "no_approved_models" | "invalid_pin" | "unapproved_model";
export class ReviewModelPolicyError extends Error {
  constructor(
    readonly code: ReviewModelPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewModelPolicyError";
  }
}

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
  return left.fqid < right.fqid ? -1 : left.fqid > right.fqid ? 1 : 0;
}
function assignment(
  role: ReviewRole,
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
    if (!ReviewRoles.some((known) => known === role))
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
      contextWindow: model.contextWindow,
    }))
    .sort(compare);
  if (approvedRoster.length === 0)
    throw new ReviewModelPolicyError(
      "no_approved_models",
      "No available model has the exact reviewer approval annotation.",
    );
  const approvedById = new Map(approvedRoster.map((candidate) => [candidate.fqid, candidate]));
  for (const role of ReviewRoles) {
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
  const assignments = {} as Record<ReviewRole, ReviewModelAssignment>;
  const choose = (role: ReviewRole, fallbackIndex: number): ReviewModelAssignment => {
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
  FocusedReviewRoles.forEach((role, index) => {
    assignments[role] = choose(role, index);
  });
  assignments["whole-change"] = choose("whole-change", 1);
  assignments.synthesis = pins.synthesis
    ? choose("synthesis", 1)
    : assignment("synthesis", assignments["whole-change"], false);
  return Object.freeze({
    ok: true,
    approvedRoster: Object.freeze(approvedRoster),
    assignments: Object.freeze(assignments),
  });
}
