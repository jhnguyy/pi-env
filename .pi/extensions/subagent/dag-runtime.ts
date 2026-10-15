import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";

import { lookupRegisteredDagExecutor } from "../_shared/dag-executor-registration";
import { isPathContained } from "../_shared/path-containment";
import { dagUsagePrefix } from "../_shared/dag-runtime-service";
import {
  DagExecutorKind,
  DagSubagentPromptMaxBytes,
  DagSubagentRuntimeFailure,
  createDagSubagentExecutor,
  type DagExecutorRegistryService,
  type DagSubagentRuntime,
  type DagSubagentRuntimeRequest,
} from "../../../src/dag/index.js";
import { WorkspaceAccess } from "./control";
import {
  runResolvedSubagentEffect,
  type ResolvedSubagentRun,
  type RunSubagentOptions,
} from "./execute";
import { discoverAgents } from "./agents";
import { resolveEffectiveCwd, isResolutionOk, isProjectTrustedForCwd } from "./resolver";

export const DagSubagentExecutorKey = "pi/subagent-v1" as const;

export class DagSubagentAdapterFailure extends Data.TaggedError("DagSubagentAdapterFailure")<{
  readonly phase: "resolution" | "execution";
  readonly message: string;
  readonly cause?: unknown;
}> {}

function resolveAgentPrompt(
  requestAgent: { readonly name: string; readonly scope: "user" | "project" } | undefined,
  cwd: string,
  ctx: ExtensionContext,
): string | undefined {
  if (!requestAgent) return undefined;
  if (requestAgent.scope === "project" && !isProjectTrustedForCwd(ctx, cwd)) {
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message: "Project DAG subagents require project scope and trusted project context.",
    });
  }
  const discovery = discoverAgents(cwd, requestAgent.scope);
  const agent = discovery.agents.find((candidate) => candidate.name === requestAgent.name);
  if (!agent)
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message: `DAG subagent agent not found: ${requestAgent.name}`,
    });
  return agent.systemPrompt;
}

function runtimeFailure(cause: DagSubagentAdapterFailure): DagSubagentRuntimeFailure {
  return new DagSubagentRuntimeFailure({ phase: cause.phase, message: cause.message, cause });
}

function resolveContainedCwd(
  request: DagSubagentRuntimeRequest,
  ctx: ExtensionContext,
  workspaceRoot?: string,
): string {
  const resolved = resolveEffectiveCwd(
    { task: request.prompt.user, cwd: request.payload.workspace.cwd },
    ctx.cwd,
  );
  const root = resolveEffectiveCwd(
    { task: request.prompt.user, cwd: workspaceRoot ?? ctx.cwd },
    ctx.cwd,
  );
  if (!isResolutionOk(resolved))
    throw new DagSubagentAdapterFailure({ phase: "resolution", message: resolved.error.message });
  if (!isResolutionOk(root) || !isPathContained(root.value, resolved.value))
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message: "DAG subagent cwd must be contained in the parent workspace.",
    });
  return resolved.value;
}

function resolveRun(
  request: DagSubagentRuntimeRequest,
  ctx: ExtensionContext,
  customTools: readonly ToolDefinition[],
  workspaceRoot?: string,
): ResolvedSubagentRun {
  const cwd = resolveContainedCwd(request, ctx, workspaceRoot);
  const agentPrompt = resolveAgentPrompt(request.payload.agent, cwd, ctx);
  const systemPrompt = agentPrompt ? `${agentPrompt}\n\n${request.prompt.system}` : request.prompt.system;
  const promptBytes = Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(request.prompt.user, "utf8");
  if (promptBytes > DagSubagentPromptMaxBytes) {
    throw new DagSubagentAdapterFailure({ phase: "resolution", message: "DAG subagent prompt exceeds the absolute prompt byte limit." });
  }
  return {
    name: request.payload.name,
    task: request.prompt.user,
    toolNames: [...request.payload.tools],
    customTools: customTools.filter((tool) => request.payload.tools.includes(tool.name)),
    modelOverride: request.payload.model,
    systemPrompt,
    cwd,
    maxTurns: request.payload.maxTurns,
    reasoning: request.payload.reasoning,
    workspaceAccess: request.payload.workspace.access === "write" ? WorkspaceAccess.Write : WorkspaceAccess.Read,
  };
}

interface DagSubagentRuntimeOptions extends RunSubagentOptions {
  readonly workspaceRootForRun?: (runId: string) => string | undefined;
  readonly customToolsForRun?: (runId: string) => readonly ToolDefinition[];
  readonly executeResolved?: typeof runResolvedSubagentEffect;
}
export function makeDagSubagentRuntime(
  ctx: ExtensionContext,
  options: DagSubagentRuntimeOptions,
): DagSubagentRuntime {
  return {
    run: (request) =>
      Effect.gen(function* () {
        const run = yield* Effect.try({
          try: () =>
            resolveRun(
              request,
              ctx,
              options.customToolsForRun?.(request.runId) ?? [],
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
        const executeResolved = options.executeResolved ?? runResolvedSubagentEffect;
        const result = yield* executeResolved(run, ctx, {
          ...options,
          runId: `${dagUsagePrefix(request.runId)}${request.nodeId}:${request.attemptId}`,
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
          lookupRegisteredDagExecutor(
            ctx.sessionManager?.getSessionId() ?? "legacy",
            sessionGeneration,
            kind,
            key,
          ),
      ),
  });
}
