import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Effect } from "effect";
import {
  registerAgentTools,
  unregisterAgentTools,
  ToolCapability,
  type AgentToolEvents,
  type ExtToolRegistration,
} from "../_shared/agent-tools";
import type { ActiveDagRuntimeService } from "../_shared/dag-runtime-service";
import { txt } from "../_shared/result";
import { toAgentTool, type ToolContract } from "../_shared/tool-contract";
import { validatePlan } from "./core";
import {
  preflightReviewEvidence,
  ReviewEvidenceResolutionFailure,
  type ReviewEvidenceResolverPayloadV1,
} from "./evidence-resolver";
import { buildReviewReadToolContracts, type ReviewRunStore } from "./runtime";
import {
  ConsolidationReviewV2Schema,
  PlanSchema,
  type ConsolidationReviewV2,
  type ReviewPlan,
  validateConsolidationReviewV2Shape,
} from "./schema";
import type { ReviewGraphToolNames } from "./review-graph";
import { validConsolidationAccounting } from "./synthesis-provenance";
import {
  admitReviewArtifacts,
  serializeReviewerDossierContext,
  type ReviewAdmission,
} from "./reviewer-dossier";

export { readVerifiedReviewArtifact } from "./reviewer-dossier";

const MAX_DECK_BYTES = 256_000;
const MAX_SUBMISSION_BYTES = 262_144;
const EmptySchema = Type.Object({}, { additionalProperties: false });

function suffixFor(reviewId: string): string {
  return createHash("sha256").update(reviewId).digest("hex").slice(0, 12);
}

function renamed(tool: AgentTool<any, any>, suffix: string): AgentTool<any, any> {
  return { ...tool, name: `${tool.name}_${suffix}` };
}

function customTool(contract: ToolContract<any, any>, cwd: string): AgentTool<any, any> {
  return toAgentTool(contract, () => ({ cwd }));
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

export interface ReviewDagTools {
  readonly names: ReviewGraphToolNames;
  readonly registrations: readonly ExtToolRegistration[];
  readonly admission: (signal?: AbortSignal) => Promise<ReviewAdmission>;
  unregister(): void;
}

export function registerReviewDagTools(options: {
  readonly pi: AgentToolEvents;
  readonly reviewId: string;
  readonly runId: string;
  readonly deckPath: string;
  readonly artifactRoot: string;
  readonly store: ReviewRunStore;
  readonly service: ActiveDagRuntimeService;
  readonly evidence: ReviewEvidenceResolverPayloadV1;
}): ReviewDagTools {
  const suffix = suffixFor(options.reviewId);
  const base = buildReviewReadToolContracts(options.store).map((contract) =>
    renamed(customTool(contract, options.store.state.snapshot.worktree), suffix),
  );
  const deckName = `review_deck_${suffix}`;
  const planName = `submit_review_plan_${suffix}`;
  const referencesName = `review_result_refs_${suffix}`;
  const synthesisName = `submit_review_synthesis_${suffix}`;
  let admission: Promise<ReviewAdmission> | undefined;
  const admittedReview = (signal?: AbortSignal) =>
    (admission ??= Effect.runPromise(
      options.service
        .reconstruct(options.runId)
        .pipe(
          Effect.flatMap((reconstruction) =>
            Effect.tryPromise(() => admitReviewArtifacts(options.artifactRoot, reconstruction)),
          ),
        ),
      { signal },
    ).catch((cause) => {
      admission = undefined;
      throw cause;
    }));
  const getReviewerDossier = async (signal?: AbortSignal) =>
    (await admittedReview(signal)).reviewers;
  const deckTool = customTool(
    {
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
    },
    options.store.state.snapshot.worktree,
  );
  const planTool = customTool(
    {
      name: planName,
      label: "Submit Review Plan",
      description: "Validate and return the canonical reading plan for this pinned snapshot.",
      parameters: PlanSchema,
      async execute(params, context) {
        if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
        const plan = params as ReviewPlan;
        const validation = validatePlan(plan, options.store.state.snapshot.metadata.changedFiles);
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
    },
    options.store.state.snapshot.worktree,
  );
  const referencesTool = customTool(
    {
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
    },
    options.store.state.snapshot.worktree,
  );
  const synthesisTool = customTool(
    {
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
    },
    options.store.state.snapshot.worktree,
  );
  const tools = [...base, deckTool, planTool, referencesTool, synthesisTool];
  const registrations = registerAgentTools(
    options.pi,
    tools.map((tool) => ({
      tool,
      capabilities: [ToolCapability.Read],
      audience: "dag" as const,
    })),
  );
  const names: ReviewGraphToolNames = {
    deck: deckName,
    read: base.map((tool) => tool.name),
    planSubmission: planName,
    resultReferences: referencesName,
    synthesisSubmission: synthesisName,
  };
  return {
    names,
    registrations,
    admission: admittedReview,
    unregister: () => unregisterAgentTools(options.pi, registrations),
  };
}
