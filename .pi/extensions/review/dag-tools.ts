import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Effect } from "effect";
import {
  DagNodeStatus,
  materializeDagTextArtifact,
  type DagSessionReconstruction,
  type DagTextArtifactReference,
} from "../../../src/dag/index.js";
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
import { makeReviewReadToolContracts, type ReviewRunStore } from "./runtime";
import {
  PlanSchema,
  SynthesisReviewSchema,
  type ReviewerOutput,
  type ReviewPlan,
  type SynthesisReview,
  validateReviewerOutputShape,
  validateSynthesisReviewShape,
} from "./schema";
import {
  EvidenceResolverNode,
  ReviewerNodes,
  type ReviewGraphToolNames,
} from "./review-graph";
import { validSynthesisSources } from "./synthesis-provenance";

const MAX_DECK_BYTES = 256_000;
const MAX_SUBMISSION_BYTES = 262_144;
const MAX_RESULT_CONTEXT_BYTES = 1_750_000;
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

export async function readVerifiedReviewArtifact(
  artifactRoot: string,
  referenceValue: unknown,
  expected: {
    readonly runId: string;
    readonly producerNodeId: string;
    readonly outputName: string;
  },
): Promise<{ reference: DagTextArtifactReference; text: string }> {
  return Effect.runPromise(
    materializeDagTextArtifact(artifactRoot, referenceValue, expected, MAX_RESULT_CONTEXT_BYTES),
  );
}

export async function collectReviewResultArtifacts(
  artifactRoot: string,
  reconstruction: DagSessionReconstruction,
): Promise<{
  readonly succeeded: readonly {
    readonly nodeId: string;
    readonly outputName: string;
    readonly reference: DagTextArtifactReference;
    readonly text: string;
  }[];
  readonly failed: readonly string[];
}> {
  const succeeded: Array<{
    nodeId: string;
    outputName: string;
    reference: DagTextArtifactReference;
    text: string;
  }> = [];
  const failed: string[] = [];
  let bytes = 0;
  for (const node of reconstruction.state.nodes) {
    if (node.nodeId === "synthesis" || node.nodeId === EvidenceResolverNode.nodeId) continue;
    if (node.status !== DagNodeStatus.Succeeded) {
      failed.push(node.nodeId);
      continue;
    }
    for (const [outputName, referenceValue] of Object.entries(node.outputs)) {
      const artifact = await readVerifiedReviewArtifact(artifactRoot, referenceValue, {
        runId: reconstruction.graph.runId,
        producerNodeId: node.nodeId,
        outputName,
      });
      bytes += Buffer.byteLength(artifact.text, "utf8");
      if (bytes > MAX_RESULT_CONTEXT_BYTES)
        throw new Error("Reviewer result context exceeds the absolute byte limit.");
      succeeded.push({ nodeId: node.nodeId, outputName, ...artifact });
    }
  }
  return Object.freeze({
    succeeded: Object.freeze(succeeded),
    failed: Object.freeze(failed.sort()),
  });
}

export interface ReviewDagTools {
  readonly names: ReviewGraphToolNames;
  readonly registrations: readonly ExtToolRegistration[];
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
  const base = makeReviewReadToolContracts(options.store).map((contract) =>
    renamed(customTool(contract, options.store.state.snapshot.worktree), suffix),
  );
  const deckName = `review_deck_${suffix}`;
  const planName = `submit_review_plan_${suffix}`;
  const referencesName = `review_result_refs_${suffix}`;
  const synthesisName = `submit_review_synthesis_${suffix}`;
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
      description: "Read verified successful result artifacts and explicit failed node names.",
      parameters: EmptySchema,
      async execute(_params, context) {
        if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
        const reconstruction = await Effect.runPromise(options.service.reconstruct(options.runId), {
          signal: context.signal,
        });
        const collected = await collectReviewResultArtifacts(options.artifactRoot, reconstruction);
        const value = {
          succeeded: collected.succeeded.map((item) => ({
            nodeId: item.nodeId,
            outputName: item.outputName,
            reference: item.reference,
            text: item.text,
          })),
          failed: collected.failed,
        };
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text, "utf8") > MAX_RESULT_CONTEXT_BYTES)
          throw new Error("Reviewer result context exceeds the absolute byte limit.");
        return {
          content: [txt(text)],
          details: { succeeded: collected.succeeded.length, failed: collected.failed.length },
        };
      },
    },
    options.store.state.snapshot.worktree,
  );
  const synthesisTool = customTool(
    {
      name: synthesisName,
      label: "Submit Review Synthesis",
      description: "Validate and return the canonical synthesized review with explicit coverage.",
      parameters: SynthesisReviewSchema,
      async execute(params, context) {
        if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
        const raw = params as SynthesisReview;
        const reconstruction = await Effect.runPromise(
          options.service.reconstruct(options.runId),
          { signal: context.signal },
        );
        const artifacts = await collectReviewResultArtifacts(
          options.artifactRoot,
          reconstruction,
        );
        const textByNode = new Map(
          artifacts.succeeded.map((artifact) => [artifact.nodeId, artifact.text]),
        );
        const reviewers = ReviewerNodes.flatMap((node) => {
          try {
            const decoded = JSON.parse(textByNode.get(node.nodeId) ?? "") as unknown;
            return validateReviewerOutputShape(decoded) && decoded.role === node.role
              ? [decoded]
              : [];
          } catch {
            return [];
          }
        });
        if (!validateSynthesisReviewShape(raw) || !validSynthesisSources(raw, reviewers))
          return {
            content: [
              txt(
                "Synthesis provenance is invalid. Copy each finding exactly from every named source reviewer and retry.",
              ),
            ],
            isError: true,
            details: { ok: false, reason: "invalid-provenance" },
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
    unregister: () => unregisterAgentTools(options.pi, registrations),
  };
}
