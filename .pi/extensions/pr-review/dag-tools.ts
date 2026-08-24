import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Effect } from "effect";
import {
  admitDagTextArtifacts,
  DagNodeStatus,
  parseDagTextArtifactReference,
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
import { makeReviewReadToolContracts, type ReviewRunStore } from "./runtime";
import {
  PlanSchema,
  ReviewerOutputSchema,
  SynthesisReviewSchema,
  type ReviewerOutput,
  type ReviewPlan,
  type SynthesisReview,
} from "./schema";
import type { ReviewGraphToolNames } from "./review-graph";

const MAX_DECK_BYTES = 256_000;
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

export async function readVerifiedReviewArtifact(
  artifactRoot: string,
  referenceValue: unknown,
): Promise<{ reference: DagTextArtifactReference; text: string }> {
  const reference = parseDagTextArtifactReference(referenceValue);
  const admitted = await Effect.runPromise(
    admitDagTextArtifacts(artifactRoot, reference.runId, reference.producerNodeId, {
      [reference.outputName]: reference.path,
    }),
  );
  const verified = admitted[reference.outputName];
  if (!verified || canonical(verified) !== canonical(reference))
    throw new Error("DAG reviewer artifact reference changed after publication.");
  return { reference, text: readFileSync(path.join(artifactRoot, reference.path), "utf8") };
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
    if (node.nodeId === "synthesis") continue;
    if (node.status !== DagNodeStatus.Succeeded) {
      failed.push(node.nodeId);
      continue;
    }
    for (const [outputName, referenceValue] of Object.entries(node.outputs)) {
      const artifact = await readVerifiedReviewArtifact(artifactRoot, referenceValue);
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
}): ReviewDagTools {
  const suffix = suffixFor(options.reviewId);
  const base = makeReviewReadToolContracts(options.store).map((contract) =>
    renamed(customTool(contract, options.store.state.snapshot.worktree), suffix),
  );
  const deckName = `review_deck_${suffix}`;
  const planName = `submit_review_plan_${suffix}`;
  const reviewerName = `submit_reviewer_result_${suffix}`;
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
        return { content: [txt(canonical(plan))], details: validation };
      },
    },
    options.store.state.snapshot.worktree,
  );
  const reviewerTool = customTool(
    {
      name: reviewerName,
      label: "Submit Reviewer Result",
      description: "Validate and return one canonical focused reviewer result.",
      parameters: ReviewerOutputSchema,
      async execute(params, context) {
        if (context.signal?.aborted) throw new Error("Review tool execution cancelled.");
        const raw = params as ReviewerOutput;
        return {
          content: [txt(canonical(raw))],
          details: { ok: true, findings: raw.findings.length },
        };
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
        return {
          content: [txt(canonical(raw))],
          details: { ok: true, findings: raw.findings.length, status: raw.coverage.status },
        };
      },
    },
    options.store.state.snapshot.worktree,
  );
  const tools = [...base, deckTool, planTool, reviewerTool, referencesTool, synthesisTool];
  const registrations = registerAgentTools(
    options.pi,
    tools.map((tool) => ({ tool, capabilities: [ToolCapability.Read] })),
  );
  const names: ReviewGraphToolNames = {
    deck: deckName,
    read: base.map((tool) => tool.name),
    planSubmission: planName,
    reviewerSubmission: reviewerName,
    resultReferences: referencesName,
    synthesisSubmission: synthesisName,
  };
  return {
    names,
    registrations,
    unregister: () => unregisterAgentTools(options.pi, registrations),
  };
}
