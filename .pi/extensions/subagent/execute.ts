/**
 * Core execution for persistent in-process subagents.
 */

import { agentLoop } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import { Data, Effect } from "effect";

import {
  withToolingTelemetryRuntime,
  type ToolingDiagnostics,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling";
import { slugify } from "../_shared/slug";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { readOptionalAgentSettings } from "../_shared/agent-settings";
import { loadSubagentRuntimeConfig, resolveSubagentRuntimeConfig } from "./config";
import {
  getOrCreateSubagentRunSupervisor,
  SubagentAdmissionError,
  SubagentRunKind,
  SubagentRunOutcome,
  WorkspaceAccess,
  type SubagentRunKind as SubagentRunKindValue,
  type SubagentRunSupervisor,
  type WorkspaceAccess as WorkspaceAccessValue,
} from "./control";
import { SubagentExecutionError, SubagentExecutionPhase } from "./errors";
import { isResolutionOk, resolveSubagentExecutionPlan, type SubagentParams } from "./resolver";
import type { SubagentDetails } from "./types";
import {
  recordSubagentResult,
  SubagentRunAccumulator,
  SubagentUsageLedger,
  SubagentUsageMode,
  zeroUsage,
} from "./usage";

export const SUBAGENT_TELEMETRY_SERVICE_NAME = "pi-env-subagent" as const;

const SubagentOperation = {
  Resolve: "resolve",
  Session: "session",
  AgentLoop: "agent_loop",
  Run: "run",
} as const;

const SubagentSpanName = {
  Resolve: "tooling.subagent.resolve",
  Session: "tooling.subagent.session",
  AgentLoop: "tooling.subagent.agent_loop",
  Run: "tooling.subagent.run",
} as const;

export function getSubagentSessionName(name: string): string {
  return `sub-${slugify(name, { fallback: "agent" })}`;
}

export function hasReachedTurnLimit(turns: number, maxTurns: number | undefined): boolean {
  return maxTurns !== undefined && turns >= maxTurns;
}

interface PersistentSubagentSession {
  manager: SessionManager;
  file?: string;
  id: string;
  name: string;
}

export function createPersistentSubagentSession(
  name: string,
  ctx: ExtensionContext,
  cwd = ctx.cwd,
): PersistentSubagentSession {
  const manager = SessionManager.create(cwd, ctx.sessionManager.getSessionDir(), {
    parentSession: ctx.sessionManager.getSessionFile(),
  });
  const sessionName = getSubagentSessionName(name);
  manager.appendSessionInfo(sessionName);
  manager.appendThinkingLevelChange("off");
  return { manager, file: manager.getSessionFile(), id: manager.getSessionId(), name: sessionName };
}

export function buildErrorDetails(
  params: SubagentParams,
  toolNames: string[],
  modelOverride: string | undefined,
  reason: string,
): SubagentDetails {
  return {
    name: params.name ?? "unnamed",
    task: params.task,
    agent: params.agent,
    toolNames,
    modelOverride,
    maxTurns: params.max_turns,
    cwd: params.cwd,
    finalOutput: "",
    toolCallCount: 0,
    usage: zeroUsage(),
    stopReason: reason,
    isError: true,
    turnLimitExceeded: false,
  };
}

export interface RunSubagentOptions {
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  onUsage?: (details: SubagentDetails) => void;
  signal?: AbortSignal;
  ledger?: SubagentUsageLedger;
  runId?: string;
  env?: Readonly<Record<string, string | undefined>>;
  telemetryExporter?: SpanExporter;
  telemetryRuntime?: ToolingTelemetryRuntime;
  executionMode?: SubagentUsageMode;
  runKind?: SubagentRunKindValue;
  supervisor?: SubagentRunSupervisor;
  workspaceAccess?: WorkspaceAccessValue;
}

export interface ResolvedSubagentRun {
  name: string;
  task: string;
  tools: AgentTool<any, any>[];
  toolNames: string[];
  model: unknown;
  modelOverride?: string;
  systemPrompt: string;
  cwd: string;
  maxTurns?: number;
  workspaceAccess?: WorkspaceAccessValue;
}

class SubagentAgentLoopFailure extends Data.TaggedError("SubagentAgentLoopFailure")<{
  readonly cause: unknown;
}> {}

function executionError(phase: SubagentExecutionPhase): SubagentExecutionError {
  return new SubagentExecutionError({
    phase,
    message: `Subagent ${phase.replace("_", " ")} failed`,
  });
}

function runResolvedSubagentWorkflow(
  run: ResolvedSubagentRun,
  ctx: ExtensionContext,
  options: RunSubagentOptions,
  diagnostics: ToolingDiagnostics,
): Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError> {
  const mode = options.executionMode ?? SubagentUsageMode.Sync;
  const workflow = Effect.gen(function* () {
    const {
      tools: resolvedTools,
      toolNames,
      model: resolvedModel,
      systemPrompt,
      cwd: effectiveCwd,
    } = run;
    const name = run.name;
    const maxTurns = run.maxTurns;
    const childSession = yield* diagnostics.span(
      SubagentSpanName.Session,
      { operation: SubagentOperation.Session, mode },
      Effect.try({
        try: () => {
          const session = createPersistentSubagentSession(name, ctx, effectiveCwd);
          session.manager.appendModelChange(
            (resolvedModel as AgentLoopConfig["model"]).provider,
            (resolvedModel as AgentLoopConfig["model"]).id,
          );
          return session;
        },
        catch: () => executionError(SubagentExecutionPhase.Session),
      }),
    );

    const accumulator = new SubagentRunAccumulator(
      {
        name,
        task: run.task,
        toolNames,
        modelOverride: run.modelOverride,
        maxTurns,
        sessionFile: childSession.file,
        sessionId: childSession.id,
        sessionName: childSession.name,
        cwd: effectiveCwd,
      },
      (turns) => hasReachedTurnLimit(turns, maxTurns),
    );
    const config: AgentLoopConfig = {
      model: resolvedModel as AgentLoopConfig["model"],
      convertToLlm,
      getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
      headers: { "X-Initiator": "agent" },
      shouldStopAfterTurn: () => hasReachedTurnLimit(accumulator.usage.turns, maxTurns),
    };
    const agentContext: AgentContext = { systemPrompt, messages: [], tools: resolvedTools };
    const prompts: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: run.task }],
        timestamp: Date.now(),
      } as any,
    ];

    const result = yield* diagnostics.span(
      SubagentSpanName.AgentLoop,
      {
        operation: SubagentOperation.AgentLoop,
        mode,
        tool_count: toolNames.length,
        provider: (resolvedModel as AgentLoopConfig["model"]).provider,
        model: (resolvedModel as AgentLoopConfig["model"]).id,
      },
      Effect.tryPromise({
        try: async (effectSignal) => {
          const signal = options.signal
            ? AbortSignal.any([options.signal, effectSignal])
            : effectSignal;
          const stream = agentLoop(prompts, agentContext, config, signal, streamSimple);
          for await (const event of stream) {
            const ev = event as AgentEvent;
            const appended = accumulator.acceptEvent(ev);
            if (appended) childSession.manager.appendMessage(appended as any);
            if (appended?.role === "assistant")
              options.onUsage?.(accumulator.progressResult().details);
            if (ev.type === "turn_end") options.onUpdate?.(accumulator.progressResult());
          }
          return accumulator.success(await stream.result());
        },
        catch: (cause) => new SubagentAgentLoopFailure({ cause }),
      }).pipe(
        Effect.matchEffect({
          onSuccess: (result) =>
            diagnostics.annotate({ outcome: "success" }).pipe(Effect.as(result)),
          onFailure: (error) =>
            diagnostics
              .annotate({ outcome: "failure", error_kind: "agent_loop" })
              .pipe(Effect.as(accumulator.failure(error.cause, options.signal?.aborted === true))),
        }),
      ),
    );
    yield* diagnostics.annotate({
      outcome: result.details.isError ? "failure" : "success",
      error_kind: result.details.isError ? "agent_loop" : undefined,
      tool_count: toolNames.length,
      provider: (resolvedModel as AgentLoopConfig["model"]).provider,
      model: (resolvedModel as AgentLoopConfig["model"]).id,
    });
    return recordSubagentResult(options.ledger, options.runId, SubagentUsageMode.Sync, result);
  }).pipe(
    Effect.tapError((error) =>
      diagnostics.annotate({ outcome: "failure", error_kind: error.phase }),
    ),
  );
  return diagnostics.span(
    SubagentSpanName.Run,
    { operation: SubagentOperation.Run, mode },
    workflow,
  );
}

function resolveSupervisor(
  ctx: ExtensionContext,
  options: RunSubagentOptions,
): SubagentRunSupervisor {
  if (options.supervisor) return options.supervisor;
  const sessionId = ctx.sessionManager.getSessionId();
  const settings = readOptionalAgentSettings(undefined, ctx.cwd);
  const enabledModels = Array.isArray(settings?.enabledModels) ? settings.enabledModels : [];
  let config;
  try {
    config = loadSubagentRuntimeConfig(ctx.cwd, enabledModels);
  } catch {
    config = resolveSubagentRuntimeConfig({}, enabledModels);
  }
  return getOrCreateSubagentRunSupervisor(sessionId, config);
}

function modelKey(model: unknown): string {
  const candidate = model as { provider?: unknown; id?: unknown };
  return typeof candidate.provider === "string" && typeof candidate.id === "string"
    ? `${candidate.provider}/${candidate.id}`
    : "unknown/unknown";
}

function runControlledResolvedSubagentWorkflow(
  run: ResolvedSubagentRun,
  ctx: ExtensionContext,
  options: RunSubagentOptions,
  diagnostics: ToolingDiagnostics,
): Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError | SubagentAdmissionError> {
  const supervisor = resolveSupervisor(ctx, options);
  const workspaceAccess = options.workspaceAccess ?? run.workspaceAccess ?? WorkspaceAccess.Read;
  const kind =
    options.runKind ??
    (options.executionMode === SubagentUsageMode.Async ? SubagentRunKind.Async : SubagentRunKind.Sync);
  return Effect.acquireUseRelease(
    supervisor.acquireEffect({
      runId: options.runId,
      kind,
      model: modelKey(run.model),
      cwd: run.cwd,
      workspaceAccess,
      signal: options.signal,
    }),
    (lease) =>
      runResolvedSubagentWorkflow(
        run,
        ctx,
        {
          ...options,
          signal: lease.signal,
          onUsage: (details) => {
            lease.updateUsage(details.usage);
            options.onUsage?.(details);
          },
        },
        diagnostics,
      ).pipe(Effect.tap((result) => Effect.sync(() => lease.updateUsage(result.details.usage)))),
    (lease) =>
      Effect.sync(() => {
        lease.release(
          lease.signal.aborted ? SubagentRunOutcome.Cancelled : SubagentRunOutcome.Completed,
        );
      }),
  );
}

function runSubagentWorkflow(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions,
  diagnostics: ToolingDiagnostics,
): Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError | SubagentAdmissionError> {
  const mode = options.executionMode ?? SubagentUsageMode.Sync;
  return Effect.gen(function* () {
    const plan = yield* diagnostics.span(
      SubagentSpanName.Resolve,
      { operation: SubagentOperation.Resolve, mode },
      Effect.try({
        try: () => resolveSubagentExecutionPlan(params, ctx, registeredExtTools),
        catch: () => executionError(SubagentExecutionPhase.Session),
      }),
    );
    if (!isResolutionOk(plan)) {
      yield* diagnostics.annotate({ outcome: "failure", error_kind: "resolution" });
      const resolutionResult: AgentToolResult<SubagentDetails> = {
        content: [{ type: "text", text: plan.error.message }],
        details: buildErrorDetails(
          params,
          plan.error.toolNames,
          plan.error.modelOverride ?? params.model,
          plan.error.reason,
        ),
      };
      return resolutionResult;
    }
    return yield* runControlledResolvedSubagentWorkflow(
      {
        name: params.name ?? "unnamed",
        task: params.task,
        tools: plan.value.tools,
        toolNames: plan.value.toolNames,
        model: plan.value.model,
        modelOverride: params.model,
        systemPrompt: plan.value.systemPrompt,
        cwd: plan.value.effectiveCwd,
        maxTurns: params.max_turns,
        workspaceAccess: plan.value.workspaceAccess,
      },
      ctx,
      options,
      diagnostics,
    );
  });
}

function withSubagentTelemetry(
  options: RunSubagentOptions,
  workflowWith: (
    runtime: ToolingTelemetryRuntime,
  ) => Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError | SubagentAdmissionError>,
): Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError | SubagentAdmissionError> {
  if (options.telemetryRuntime) {
    return options.telemetryRuntime.provide(workflowWith(options.telemetryRuntime));
  }

  return withToolingTelemetryRuntime(
    {
      env: options.env ?? process.env,
      exporter: options.telemetryExporter,
      serviceName: SUBAGENT_TELEMETRY_SERVICE_NAME,
    },
    workflowWith,
  ).pipe(
    Effect.catchTag("ToolingOtelConfigError", () =>
      Effect.fail(executionError(SubagentExecutionPhase.Session)),
    ),
  );
}

export function runSubagentEffect(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions = {},
): Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError | SubagentAdmissionError> {
  return withSubagentTelemetry(options, (runtime) =>
    runSubagentWorkflow(params, ctx, registeredExtTools, options, runtime.diagnostics),
  );
}

export function runResolvedSubagentEffect(
  run: ResolvedSubagentRun,
  ctx: ExtensionContext,
  options: RunSubagentOptions = {},
): Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError | SubagentAdmissionError> {
  return withSubagentTelemetry(options, (runtime) =>
    runControlledResolvedSubagentWorkflow(
      run,
      ctx,
      { ...options, runKind: options.runKind ?? SubagentRunKind.Direct },
      runtime.diagnostics,
    ),
  );
}

/** Promise compatibility boundary for callers outside the Effect workflow. */
export function runSubagent(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
  return Effect.runPromise(runSubagentEffect(params, ctx, registeredExtTools, options));
}
