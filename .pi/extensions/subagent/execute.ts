import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  withToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling";
import { slugify } from "../_shared/slug";
import {
  loadSubagentRuntimeConfig,
  resolveSubagentRuntimeConfig,
  SubagentSessionStorage,
  type SubagentSessionStorage as SubagentSessionStorageValue,
} from "./config";
import {
  getOrCreateSubagentRunSupervisor,
  SubagentAdmissionError,
  type SubagentRunSupervisor,
} from "./control";
import { SubagentExecutionError, SubagentExecutionPhase } from "./errors";
import { isResolutionOk, resolveSubagentExecutionPlan, type SubagentParams } from "./resolver";
import type { SubagentDetails } from "./types";
import {
  recordSubagentResult,
  SubagentUsageMode,
  zeroUsage,
} from "./usage";
import { NativeChildOwner } from "./native-child";
export type { NativeChildSession } from "./child-types";

export const SUBAGENT_TELEMETRY_SERVICE_NAME = "pi-env-subagent" as const;
function getSubagentSessionName(name: string): string {
  return `sub-${slugify(name, { fallback: "agent" })}`;
}
interface PersistentSubagentSession {
  manager: SessionManager;
  file?: string;
  id: string;
  name: string;
}

function childSessionDirectory(ctx: SubagentParentContext): string | undefined {
  const parentDirectory = ctx.sessionManager.getSessionDir();
  if (!parentDirectory) return undefined;

  const parentId = ctx.sessionManager.getSessionId();
  const directoryName =
    parentId.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parentId)
      ? parentId
      : `sha256-${createHash("sha256").update(parentId).digest("hex")}`;
  return join(parentDirectory, "_children", directoryName);
}

export function createPersistentSubagentSession(
  name: string,
  ctx: SubagentParentContext,
  cwd = ctx.cwd,
  sessionStorage: SubagentSessionStorageValue = SubagentSessionStorage.Nested,
): PersistentSubagentSession {
  const sessionDir =
    sessionStorage === SubagentSessionStorage.Nested
      ? childSessionDirectory(ctx)
      : ctx.sessionManager.getSessionDir();
  const manager = SessionManager.create(cwd, sessionDir, {
    parentSession: ctx.sessionManager.getSessionFile(),
  });
  const sessionName = getSubagentSessionName(name);
  manager.appendSessionInfo(sessionName);
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
    cwd: params.cwd,
    finalOutput: "",
    toolCallCount: 0,
    usage: zeroUsage(),
    stopReason: reason,
    isError: true,
    turnLimitExceeded: false,
  };
}

export type { RunSubagentOptions, ResolvedSubagentRun, SubagentParentContext } from "./execution-types";
import type { RunSubagentOptions, ResolvedSubagentRun, SubagentParentContext } from "./execution-types";
function executionError(phase: SubagentExecutionPhase, cause?: unknown): SubagentExecutionError {
  return new SubagentExecutionError({
    phase,
    message: cause instanceof Error ? cause.message : `Subagent ${phase} failed`,
  });
}
function resolveSessionStorage(ctx: SubagentParentContext): SubagentSessionStorageValue {
  try {
    return loadSubagentRuntimeConfig(ctx.cwd).sessionStorage;
  } catch {
    return SubagentSessionStorage.Nested;
  }
}

function resolveSupervisor(
  ctx: SubagentParentContext,
  options: RunSubagentOptions,
): SubagentRunSupervisor {
  if (options.supervisor) return options.supervisor;
  const sessionId = ctx.sessionManager.getSessionId();
  let config;
  try {
    config = loadSubagentRuntimeConfig(ctx.cwd);
  } catch {
    config = resolveSubagentRuntimeConfig({});
  }
  return getOrCreateSubagentRunSupervisor(sessionId, config);
}

function withSubagentTelemetry(
  options: RunSubagentOptions,
  workflowWith: (
    runtime: ToolingTelemetryRuntime,
  ) => Effect.Effect<
    AgentToolResult<SubagentDetails>,
    SubagentExecutionError | SubagentAdmissionError
  >,
): Effect.Effect<
  AgentToolResult<SubagentDetails>,
  SubagentExecutionError | SubagentAdmissionError
> {
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

export function runResolvedSubagentEffect(
  run: ResolvedSubagentRun,
  ctx: SubagentParentContext,
  options: RunSubagentOptions = {},
): Effect.Effect<
  AgentToolResult<SubagentDetails>,
  SubagentExecutionError | SubagentAdmissionError
> {
  return withSubagentTelemetry(options, (runtime) =>
    runtime.diagnostics.span(
      "tooling.subagent.run",
      { operation: "run", mode: options.executionMode ?? SubagentUsageMode.Sync },
      Effect.callback<
        AgentToolResult<SubagentDetails>,
        SubagentExecutionError | SubagentAdmissionError
      >((resume) => {
        let child: NativeChildOwner | undefined;
        const work = (async () => {
          const persistent = createPersistentSubagentSession(
            run.name,
            ctx,
            run.cwd,
            options.sessionStorage ?? resolveSessionStorage(ctx),
          );
          const supervisor = resolveSupervisor(ctx, options);
          child = new NativeChildOwner(run, ctx, persistent.manager, supervisor, options);
          try {
            supervisor.retainChild(child);
            options.onChild?.(child);
            const result = await child.runInitial();
            return recordSubagentResult(
              options.ledger,
              options.runId,
              options.executionMode ?? SubagentUsageMode.Sync,
              result,
            );
          } catch (error) {
            await child.close();
            throw error;
          }
        })();
        work.then(
          (result) => resume(Effect.succeed(result)),
          (error) =>
            resume(
              Effect.fail(
                error instanceof SubagentAdmissionError
                  ? error
                  : executionError(SubagentExecutionPhase.Session, error),
              ),
            ),
        );
        // Effect interruption waits native abort and settlement, not a timer or an early lease release.
        return Effect.promise(async () => {
          await child?.cancel();
          await work.catch(() => undefined);
        });
      }),
    ),
  );
}

export function runSubagentEffect(
  params: SubagentParams,
  ctx: SubagentParentContext,
  options: RunSubagentOptions = {},
): Effect.Effect<
  AgentToolResult<SubagentDetails>,
  SubagentExecutionError | SubagentAdmissionError
> {
  return Effect.suspend(() => {
    const plan = resolveSubagentExecutionPlan(params, ctx);
    if (!isResolutionOk(plan))
      return Effect.succeed({
        content: [{ type: "text" as const, text: plan.error.message }],
        details: buildErrorDetails(
          params,
          plan.error.toolNames,
          plan.error.modelOverride,
          plan.error.reason,
        ),
      });
    return runResolvedSubagentEffect(
      {
        name: params.name ?? "unnamed",
        task: params.task,
        cwd: plan.value.effectiveCwd,
        modelOverride: plan.value.modelOverride,
        systemPrompt: plan.value.systemPrompt,
        toolNames: plan.value.toolNames,
        workspaceAccess: plan.value.workspaceAccess,
      },
      ctx,
      options,
    );
  });
}
