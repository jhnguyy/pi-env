import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";

import * as DagExecutorRegistration from "../_shared/dag-executor-registration";
import * as PathContainment from "../_shared/path-containment";
import * as DagRuntimeService from "../_shared/dag-runtime-service";
import {
  DagExecutorKind,
  DagSubagentPromptMaxBytes,
  DagSubagentRuntimeFailure,
  createDagSubagentExecutor,
  type DagExecutorRegistryService,
  type DagSubagentRuntime,
  type DagSubagentRuntimeRequest,
} from "../../../src/dag/index.js";
import * as Control from "./control";
import * as Execute from "./execute";
import * as Resolver from "./resolver";
import type { ReviewCapability } from "../../../src/subagent-service/review-capability";
import * as Usage from "./usage";

export const DagSubagentExecutorKey = "pi/subagent-v1" as const;

export class DagSubagentAdapterFailure extends Data.TaggedError("DagSubagentAdapterFailure")<{
  readonly phase: "resolution" | "execution";
  readonly message: string;
  readonly cause?: unknown;
}> {}

function runtimeFailure(cause: DagSubagentAdapterFailure): DagSubagentRuntimeFailure {
  return new DagSubagentRuntimeFailure({ phase: cause.phase, message: cause.message, cause });
}

function resolveContainedCwd(
  request: DagSubagentRuntimeRequest,
  ctx: ExtensionContext,
  workspaceRoot?: string,
): string {
  const resolved = Resolver.resolveEffectiveCwd(
    { task: request.prompt.user, cwd: request.payload.workspace.cwd },
    ctx.cwd,
  );
  const root = Resolver.resolveEffectiveCwd(
    { task: request.prompt.user, cwd: workspaceRoot ?? ctx.cwd },
    ctx.cwd,
  );
  if (!Resolver.isResolutionOk(resolved))
    throw new DagSubagentAdapterFailure({ phase: "resolution", message: resolved.error.message });
  if (!Resolver.isResolutionOk(root) || !PathContainment.isPathContained(root.value, resolved.value))
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message: "DAG subagent cwd must be contained in the parent workspace.",
    });
  return resolved.value;
}

function resolveRun(
  request: DagSubagentRuntimeRequest,
  ctx: ExtensionContext,
  reviewCapability: ReviewCapability | undefined,
  workspaceRoot?: string,
): Execute.ResolvedSubagentRun {
  const cwd = resolveContainedCwd(request, ctx, workspaceRoot);
  const systemPrompt = request.prompt.system;
  const promptBytes = Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(request.prompt.user, "utf8");
  if (promptBytes > DagSubagentPromptMaxBytes) {
    throw new DagSubagentAdapterFailure({ phase: "resolution", message: "DAG subagent prompt exceeds the absolute prompt byte limit." });
  }
  return {
    name: request.payload.name,
    task: request.prompt.user,
    toolNames: [...request.payload.tools],
    reviewCapability,
    modelOverride: request.payload.model,
    systemPrompt,
    cwd,
    maxTurns: request.payload.maxTurns,
    reasoning: request.payload.reasoning,
    workspaceAccess: request.payload.workspace.access === "write" ? Control.WorkspaceAccess.Write : Control.WorkspaceAccess.Read,
  };
}

interface DagSubagentRuntimeOptions extends Execute.RunSubagentOptions {
  readonly workspaceRootForRun?: (runId: string) => string | undefined;
  readonly reviewCapabilityForRun?: (runId: string) => Promise<ReviewCapability | undefined>;
  readonly executeResolved?: typeof Execute.runResolvedSubagentEffect;
}
export function makeDagSubagentRuntime(
  ctx: ExtensionContext,
  options: DagSubagentRuntimeOptions,
): DagSubagentRuntime {
  return {
    run: (request) =>
      Effect.gen(function* () {
        const reviewCapability = yield* Effect.tryPromise({
          try: async () => options.reviewCapabilityForRun?.(request.runId),
          catch: (cause) => new DagSubagentRuntimeFailure({ phase: "resolution", message: "Review capability reconstruction failed.", cause }),
        });
        const run = yield* Effect.try({
          try: () =>
            resolveRun(
              request,
              ctx,
              reviewCapability,
              options.workspaceRootForRun?.(request.runId),
            ),
          catch: (cause) =>
            runtimeFailure(
              cause instanceof DagSubagentAdapterFailure
                ? cause
                : new DagSubagentAdapterFailure({
                    phase: "resolution",
                    message: "DAG subagent resolution failed.",
                    cause,
                  }),
            ),
        });
        const executeResolved = options.executeResolved ?? Execute.runResolvedSubagentEffect;
        const result = yield* executeResolved(run, ctx, {
          ...options,
          // Group lifetime by graph, but deduplicate only the same node attempt.
          runId: request.runId,
          requestId: `${DagRuntimeService.dagUsagePrefix(request.runId)}${request.nodeId}:${request.attemptId}`,
          ledger: undefined,
          workspaceAccess: run.workspaceAccess,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new DagSubagentRuntimeFailure({
                phase: "execution",
                message: "DAG subagent execution failed",
                cause,
              }),
          ),
        );
        options.ledger?.record(
          `${DagRuntimeService.dagUsagePrefix(request.runId)}${request.nodeId}:${request.attemptId}`,
          options.executionMode ?? Usage.SubagentUsageMode.Sync,
          result.details,
        );
        const admissibleOneRequestResult =
          request.payload.maxTurns === 1 &&
          request.payload.tools.length === 0 &&
          result.details.usage?.turns === 1 &&
          result.details.finalOutput.length > 0;
        if (
          result.details.isError ||
          (result.details.turnLimitExceeded && !admissibleOneRequestResult)
        )
          return yield* new DagSubagentRuntimeFailure({
            phase: "execution",
            message: result.details.turnLimitExceeded
              ? "DAG subagent exceeded turn limit."
              : "DAG subagent returned an error result.",
            cause: result.details,
          });
        return result.details.finalOutput;
      }),
  };
}

export function createDagSubagentExecutorRegistry(
  ctx: ExtensionContext,
  artifactRoot: string,
  sessionGeneration: string,
  options: DagSubagentRuntimeOptions,
): DagExecutorRegistryService {
  const executor = createDagSubagentExecutor({
    artifactRoot,
    runtime: makeDagSubagentRuntime(ctx, options),
  });
  return Object.freeze({
    lookup: (kind: DagExecutorKind, key: string) =>
      Effect.succeed(
        (kind === DagExecutorKind.Subagent && key === DagSubagentExecutorKey
          ? executor
          : undefined) ??
          DagExecutorRegistration.lookupRegisteredDagExecutor(
            ctx.sessionManager?.getSessionId() ?? "legacy",
            sessionGeneration,
            kind,
            key,
          ),
      ),
  });
}
