import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DagSessionReconstruction } from "../dag/index.js";
import { Effect } from "effect";
import { txt } from "../../.pi/extensions/_shared/result";
import * as ToolContract from "../../.pi/extensions/_shared/tool-contract";
import { validatePlan } from "../../.pi/extensions/review/core";
import {
  preflightReviewEvidence,
  ReviewEvidenceResolutionFailure,
  type ReviewEvidenceResolverPayloadV1,
} from "../../.pi/extensions/review/evidence-resolver";
import { buildReviewReadToolContracts } from "../../.pi/extensions/review/runtime";
import {
  ConsolidationReviewV2Schema,
  PlanSchema,
  type ConsolidationReviewV2,
  type ReviewPlan,
  type ReviewState,
  validateConsolidationReviewV2Shape,
} from "../../.pi/extensions/review/schema";
import { validConsolidationAccounting } from "../../.pi/extensions/review/synthesis-provenance";
import {
  admitReviewArtifacts,
  serializeReviewerDossierContext,
  type ReviewAdmission,
} from "../../.pi/extensions/review/reviewer-dossier";

export { readVerifiedReviewArtifact } from "../../.pi/extensions/review/reviewer-dossier";

const MAX_DECK_BYTES = 256_000;
const MAX_SUBMISSION_BYTES = 262_144;
const EmptySchema = Type.Object({}, { additionalProperties: false });

function suffixFor(reviewId: string): string {
  return createHash("sha256").update(reviewId).digest("hex").slice(0, 12);
}

function renamed(tool: ToolDefinition, suffix: string): ToolDefinition {
  return { ...tool, name: `${tool.name}_${suffix}` };
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function boundedSubmission(value: unknown): string {
  const text = canonical(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SUBMISSION_BYTES)
    throw new Error(`Review submission exceeds the byte limit: ${bytes}/${MAX_SUBMISSION_BYTES}.`);
  return text;
}

export interface ReviewCapability {
  readonly kind: "review-v1";
  readonly reviewId: string;
  readonly runId: string;
  readonly snapshot: ReviewState["snapshot"];
  readonly deckPath: string;
  readonly artifactRoot: string;
  readonly evidence: ReviewEvidenceResolverPayloadV1;
  readonly reconstruction?: DagSessionReconstruction;
}

/** Construct private authority only inside the service, from a detached data snapshot. */
export function createReviewCapabilityTools(descriptor: ReviewCapability): readonly ToolDefinition[] {
  const options = structuredClone(descriptor);
  const suffix = suffixFor(options.reviewId);
  const base = buildReviewReadToolContracts({
    state: { snapshot: options.snapshot } as ReviewState,
    save: () => { throw new Error("Private review tools cannot mutate parent review state."); },
  }).map((contract) => renamed(ToolContract.toPiTool(contract), suffix));
  const deckName = `review_deck_${suffix}`;
  const planName = `submit_review_plan_${suffix}`;
  const referencesName = `review_result_refs_${suffix}`;
  const synthesisName = `submit_review_synthesis_${suffix}`;
  let admission: Promise<ReviewAdmission> | undefined;
  const admittedReview = (signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(new Error("Review tool execution cancelled."));
    if (!options.reconstruction) return Promise.reject(new Error("Review synthesis requires a reconstruction snapshot."));
    return admission ??= admitReviewArtifacts(options.artifactRoot, options.reconstruction).catch((cause) => {
      admission = undefined;
      throw cause;
    });
  };
  const getReviewerDossier = async (signal?: AbortSignal) =>
    (await Effect.runPromise(Effect.tryPromise(() => admittedReview(signal)), { signal })).reviewers;
  const deckTool = ToolContract.toPiTool<unknown, unknown>({
    name: deckName,
    label: "Review Deck",
    description: "Read the bounded review deck for this pinned review run.",
    parameters: EmptySchema,
    async execute(_params, context) {
      if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
      const text = readFileSync(options.deckPath, "utf8");
      if (Buffer.byteLength(text, "utf8") > MAX_DECK_BYTES)
        throw new Error("Review deck exceeds the tool byte limit.");
      return { content: [txt(text)], details: { bytes: Buffer.byteLength(text, "utf8") } };
    },
  });
  const planTool = ToolContract.toPiTool<unknown, unknown>({
    name: planName,
    label: "Submit Review Plan",
    description: "Validate and return the canonical reading plan for this pinned snapshot.",
    parameters: PlanSchema,
    async execute(params, context) {
      if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
      const plan = params as ReviewPlan;
      const validation = validatePlan(plan, options.snapshot.metadata.changedFiles);
      if (!validation.ok)
        return { content: [txt(validation.message)], isError: true, details: validation };
      try {
        const resolved = await preflightReviewEvidence(
          options.evidence,
          plan,
          context.signal ?? new AbortController().signal,
        );
        return {
          content: [txt(boundedSubmission(plan))],
          details: {
            ...validation,
            dossierBytes: resolved.coverage.dossierBytes,
            omissions: resolved.coverage.omissions.length,
          },
        };
      } catch (cause) {
        if (!(cause instanceof ReviewEvidenceResolutionFailure)) throw cause;
        return {
          content: [txt(`${cause.code}: ${cause.message}`)],
          isError: true,
          details: {
            code: cause.code,
            message: cause.message,
            actual: cause.actual,
            limit: cause.limit,
            path: cause.path,
          },
        };
      }
    },
  });
  const referencesTool = ToolContract.toPiTool<unknown, unknown>({
    name: referencesName,
    label: "Review Result References",
    description:
      "Read admitted raw findings with stable IDs and explicit failed and malformed node names.",
    parameters: EmptySchema,
    async execute(_params, context) {
      if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
      const dossier = await getReviewerDossier(context.signal);
      const text = serializeReviewerDossierContext(dossier);
      return {
        content: [txt(text)],
        details: {
          succeeded: dossier.admitted.length,
          failed: dossier.failed.length,
          malformed: dossier.malformed.length,
        },
      };
    },
  });
  const synthesisTool = ToolContract.toPiTool<unknown, unknown>({
    name: synthesisName,
    label: "Submit Review Synthesis",
    description: "Validate v2 editorial consolidation with exactly-once raw finding accounting.",
    parameters: ConsolidationReviewV2Schema,
    async execute(params, context) {
      if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
      const raw = params as ConsolidationReviewV2;
      const dossier = await getReviewerDossier(context.signal);
      if (
        !validateConsolidationReviewV2Shape(raw) ||
        !validConsolidationAccounting(raw, dossier.rawFindings)
      )
        return {
          content: [
            txt(
              "Synthesis provenance is invalid. Account for every admitted raw finding ID exactly once in a retained group or a dismissal with a nonblank reason.",
            ),
          ],
          isError: true,
          details: { ok: false, reason: "invalid-provenance-accounting" },
        };
      return {
        content: [txt(boundedSubmission(raw))],
        details: { ok: true, findings: raw.findings.length, status: raw.coverage.status },
      };
    },
  });
  return [...base, deckTool, planTool, referencesTool, synthesisTool];
}

interface DataContainer {
  readonly array: boolean;
  readonly prototype: unknown;
  readonly descriptors: PropertyDescriptorMap;
}

function* dataProperties(container: DataContainer, path: string): Generator<[string, unknown]> {
  const { prototype, array, descriptors } = container;
  if (!array && prototype !== null && Object.getPrototypeOf(prototype) !== null)
    throw new Error(`Review capability must contain only plain data objects at ${path}.`);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (array && key === "length") continue;
    const property = descriptors[key];
    if (typeof key !== "string" || !property.enumerable || !("value" in property))
      throw new Error("Review capability cannot contain executable or hidden authority.");
    yield [key, property.value];
  }
}

function assertDataOnly(value: unknown, ancestors = new Set<object>(), path = "capability"): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new Error("Review capability must contain only JSON data.");
  ancestors.add(value);
  const container = { array: Array.isArray(value), prototype: Object.getPrototypeOf(value), descriptors: Object.getOwnPropertyDescriptors(value) };
  for (const [key, data] of dataProperties(container, path)) {
    assertDataOnly(data, ancestors, `${path}.${key}`);
  }
  ancestors.delete(value);
}

function evidenceMatchesSnapshot(value: ReviewCapability, cwd: string): boolean {
  return value.evidence.v === 1 && value.evidence.snapshotId === value.reviewId &&
    value.evidence.worktree === cwd &&
    value.evidence.headOid === value.snapshot.metadata.headOid &&
    value.evidence.diffHash === value.snapshot.diffHash &&
    value.evidence.diffPath === value.snapshot.diffPath;
}

/** Same-user socket admission is the authority boundary; unknown capability kinds fail closed. */
export async function resolveReviewCapability(request: {
  readonly capability: unknown;
  readonly runId: string;
  readonly cwd: string;
}): Promise<{ customTools: readonly ToolDefinition[] }> {
  assertDataOnly(request.capability);
  const value = structuredClone(request.capability) as Partial<ReviewCapability> | null;
  if (!value || value.kind !== "review-v1" || typeof value.reviewId !== "string" ||
      value.runId !== request.runId || !value.snapshot || value.snapshot.id !== value.reviewId ||
      value.snapshot.worktree !== request.cwd || typeof value.deckPath !== "string" ||
      typeof value.artifactRoot !== "string" || !value.evidence ||
      !evidenceMatchesSnapshot(value as ReviewCapability, request.cwd) ||
      (value.reconstruction && value.reconstruction.graph.runId !== request.runId)) {
    throw new Error("Invalid or mismatched private review capability.");
  }
  return { customTools: createReviewCapabilityTools(value as ReviewCapability) };
}
