import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";

import type { ExtToolRegistration } from "../_shared/agent-tools";
import { lookupRegisteredDagExecutor } from "../_shared/dag-executor-registration";
import { isPathContained } from "../_shared/path-containment";
import { dagUsagePrefix } from "../_shared/dag-runtime-service";
import {
  DagExecutorKind,
  DagSubagentPromptMaxBytes,
  DagSubagentReservedOutputTokens,
  DagSubagentRuntimeFailure,
  makeDagSubagentExecutor,
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
import { BUILT_IN_TOOLS, resolveEffectiveCwd, resolveModel, isResolutionOk } from "./resolver";
import { ToolCapability } from "./types";

export const DagSubagentExecutorKey = "pi/subagent-v1" as const;

export class DagSubagentAdapterFailure extends Data.TaggedError("DagSubagentAdapterFailure")<{
  readonly phase: "resolution" | "execution";
  readonly message: string;
  readonly cause?: unknown;
}> {}

function registrationCapabilities(registration: ExtToolRegistration): readonly ToolCapability[] {
  return registration.capabilities;
}

function toolAccess(capabilities: Iterable<ToolCapability>): "read" | "write" {
  for (const capability of capabilities) {
    if (capability === ToolCapability.Write || capability === ToolCapability.Execute)
      return "write";
  }
  return "read";
}

function materializeExplicitTools(
  names: readonly string[],
  cwd: string,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
): { tools: AgentTool<any, any>[]; capabilities: ToolCapability[] } {
  const tools: AgentTool<any, any>[] = [];
  const capabilities: ToolCapability[] = [];
  for (const name of names) {
    const builtIn = BUILT_IN_TOOLS[name];
    if (builtIn) {
      tools.push(builtIn.factory(cwd));
      capabilities.push(...builtIn.capabilities);
      continue;
    }
    const registration = registeredExtTools.get(name);
    if (!registration)
      throw new DagSubagentAdapterFailure({
        phase: "resolution",
        message: `Unknown DAG subagent tool: ${name}`,
      });
    tools.push(
      registration.createTool?.({
        cwd,
        sessionGeneration: registration.sessionGeneration ?? "legacy",
        parentContext: ctx,
      }) ?? { ...registration.tool },
    );
    capabilities.push(...registrationCapabilities(registration));
  }
  return { tools, capabilities };
}

function resolveAgentPrompt(
  requestAgent: { readonly name: string; readonly scope: "user" | "project" } | undefined,
  cwd: string,
  ctx: ExtensionContext,
): string | undefined {
  if (!requestAgent) return undefined;
  if (requestAgent.scope === "project" && ctx.isProjectTrusted?.() !== true) {
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

function contextWindowOf(model: unknown): number | undefined {
  return typeof model === "object" &&
    model !== null &&
    "contextWindow" in model &&
    typeof (model as { contextWindow?: unknown }).contextWindow === "number"
    ? (model as { contextWindow: number }).contextWindow
    : undefined;
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

function admitPrompt(systemPrompt: string, userPrompt: string, model: unknown): void {
  const promptBytes =
    Buffer.byteLength(systemPrompt, "utf8") + Buffer.byteLength(userPrompt, "utf8");
  if (promptBytes > DagSubagentPromptMaxBytes)
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message: "DAG subagent prompt exceeds the absolute prompt byte limit.",
    });
  const contextWindow = contextWindowOf(model);
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow === undefined ||
    contextWindow <= DagSubagentReservedOutputTokens
  )
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message:
        "DAG subagent model is missing a positive integer context window larger than reserved output tokens.",
    });
  // UTF-8 bytes are a conservative upper bound for byte-fallback tokenization.
  if (promptBytes > contextWindow - DagSubagentReservedOutputTokens)
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message: "DAG subagent prompt exceeds conservative model context admission.",
    });
}

function resolveRun(
  request: DagSubagentRuntimeRequest,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  workspaceRoot?: string,
): ResolvedSubagentRun {
  const cwd = resolveContainedCwd(request, ctx, workspaceRoot);
  const agentPrompt = resolveAgentPrompt(request.payload.agent, cwd, ctx);
  const explicit = materializeExplicitTools(request.payload.tools, cwd, ctx, registeredExtTools);
  const derivedAccess = toolAccess(explicit.capabilities);
  if (derivedAccess !== request.payload.workspace.access)
    throw new DagSubagentAdapterFailure({
      phase: "resolution",
      message: `Workspace access ${request.payload.workspace.access} does not match explicit tool access ${derivedAccess}.`,
    });
  const model = resolveModel(request.payload.model, ctx.modelRegistry, [...request.payload.tools]);
  if (!isResolutionOk(model))
    throw new DagSubagentAdapterFailure({ phase: "resolution", message: model.error.message });
  const systemPrompt = agentPrompt
    ? `${agentPrompt}\n\n${request.prompt.system}`
    : request.prompt.system;
  admitPrompt(systemPrompt, request.prompt.user, model.value.model);
  return {
    name: request.payload.name,
    task: request.prompt.user,
    tools: explicit.tools,
    toolNames: [...request.payload.tools],
    model: model.value.model,
    modelOverride: request.payload.model,
    systemPrompt,
    cwd,
    maxTurns: request.payload.maxTurns,
    reasoning: request.payload.reasoning,
    workspaceAccess:
      request.payload.workspace.access === "write" ? WorkspaceAccess.Write : WorkspaceAccess.Read,
  };
}

interface DagSubagentRuntimeOptions extends RunSubagentOptions {
  readonly workspaceRootForRun?: (runId: string) => string | undefined;
}
export function makeDagSubagentRuntime(
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
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
              registeredExtTools,
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
        const result = yield* runResolvedSubagentEffect(run, ctx, {
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

export function makeDagSubagentExecutorRegistry(
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  artifactRoot: string,
  sessionGeneration: string,
  options: DagSubagentRuntimeOptions,
): DagExecutorRegistryService {
  const executor = makeDagSubagentExecutor({
    artifactRoot,
    runtime: makeDagSubagentRuntime(ctx, registeredExtTools, options),
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
