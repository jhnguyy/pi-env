import { getSupportedThinkingLevels, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import { FocusedReviewRoles, ReviewRoles, type ReviewRole } from "./review-topology";

export type ReviewRolePins = Partial<Record<ReviewRole, string>>;

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
  readonly availableRoster: readonly ReviewModelCandidate[];
  readonly assignments: Readonly<Record<ReviewRole, ReviewModelAssignment>>;
}
export type ReviewModelPolicyErrorCode = "no_available_models" | "invalid_pin";
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
function assignment(
  role: ReviewRole,
  candidate: ReviewModelCandidate,
  pinned: boolean,
): ReviewModelAssignment {
  return Object.freeze({ role, ...candidate, pinned });
}

export function resolvePrReviewModelPolicy(
  availableModels: readonly ReviewModel[],
  scopedModels: readonly Pick<ReviewModel, "provider" | "id">[],
  pins: ReviewRolePins | Readonly<Record<string, string>> = {},
): ReviewModelPolicySuccess {
  for (const role of Object.keys(pins)) {
    if (!ReviewRoles.some((known) => known === role))
      throw new ReviewModelPolicyError("invalid_pin", `Unknown PR review role pin: ${role}.`);
  }
  const authenticatedById = new Map(availableModels.map((model) => [fqid(model), model]));
  const availableRoster = [...new Set(scopedModels.map(fqid))].flatMap((id) => {
    const model = authenticatedById.get(id);
    return model
      ? [
          {
            provider: model.provider,
            model: model.id,
            fqid: id,
            reasoning: highestReasoning(model),
            contextWindow: model.contextWindow,
          },
        ]
      : [];
  });
  if (availableRoster.length === 0)
    throw new ReviewModelPolicyError(
      "no_available_models",
      "No authenticated scoped models are available for PR review. Configure /scoped-models and provider login.",
    );
  const availableByFqid = new Map(availableRoster.map((candidate) => [candidate.fqid, candidate]));
  for (const role of ReviewRoles) {
    const pin = pins[role];
    if (!pin) continue;
    if (!availableByFqid.has(pin))
      throw new ReviewModelPolicyError(
        "invalid_pin",
        `Pinned role ${role} references model ${pin} outside the authenticated scoped models.`,
      );
  }
  const assignments = {} as Record<ReviewRole, ReviewModelAssignment>;
  const choose = (role: ReviewRole, fallbackIndex: number): ReviewModelAssignment => {
    const pin = pins[role];
    const candidate = pin
      ? availableByFqid.get(pin)
      : availableRoster[fallbackIndex % availableRoster.length];
    if (!candidate)
      throw new ReviewModelPolicyError(
        "no_available_models",
        "No model is available for PR review.",
      );
    return assignment(role, candidate, pin !== undefined);
  };
  assignments["reading-plan"] = choose("reading-plan", 0);
  FocusedReviewRoles.forEach((role, index) => {
    assignments[role] = choose(role, index);
  });
  assignments["whole-change"] = choose("whole-change", FocusedReviewRoles.length);
  assignments.synthesis = pins.synthesis
    ? choose("synthesis", FocusedReviewRoles.length + 1)
    : assignment("synthesis", assignments["whole-change"], false);
  return Object.freeze({
    ok: true,
    availableRoster: Object.freeze(availableRoster),
    assignments: Object.freeze(assignments),
  });
}
