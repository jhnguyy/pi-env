import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import * as Tooling from "../../../src/telemetry/tooling";
import * as Slug from "../_shared/slug";
import * as Config from "./config";
import * as Control from "./control";
import * as Errors from "./errors";
import * as Resolver from "./resolver";
import type * as Types from "./types";
import * as Usage from "./usage";
import * as NativeChild from "./native-child";
export type { NativeChildSession } from "./child-types";

export const SUBAGENT_TELEMETRY_SERVICE_NAME = "pi-env-subagent" as const;
function getSubagentSessionName(name: string): string {
  return `sub-${Slug.slugify(name, { fallback: "agent" })}`;
}
interface PersistentSubagentSession {
  manager: SessionManager;
  file?: string;
  id: string;
  name: string;
}

function childSessionDirectory(ctx: ExecutionTypes.SubagentParentContext): string | undefined {
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
  ctx: ExecutionTypes.SubagentParentContext,
  cwd = ctx.cwd,
  sessionStorage: Config.SubagentSessionStorage = Config.SubagentSessionStorage.Nested,
): PersistentSubagentSession {
  const sessionDir =
    sessionStorage === Config.SubagentSessionStorage.Nested
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
  params: Resolver.SubagentParams,
  toolNames: string[],
  modelOverride: string | undefined,
  reason: string,
): Types.SubagentDetails {
  return {
    name: params.name ?? "unnamed",
    task: params.task,
    toolNames,
    modelOverride,
    cwd: params.cwd,
    finalOutput: "",
    toolCallCount: 0,
    usage: Usage.zeroUsage(),
    stopReason: reason,
    isError: true,
    turnLimitExceeded: false,
  };
}

export type { RunSubagentOptions, ResolvedSubagentRun, SubagentParentContext } from "./execution-types";
import type * as ExecutionTypes from "./execution-types";
function executionError(phase: Errors.SubagentExecutionPhase, cause?: unknown): Errors.SubagentExecutionError {
  return new Errors.SubagentExecutionError({
    phase,
    message: cause instanceof Error ? cause.message : `Subagent ${phase} failed`,
  });
}
function resolveSessionStorage(ctx: ExecutionTypes.SubagentParentContext): Config.SubagentSessionStorage {
  try {
    return Config.loadSubagentRuntimeConfig(ctx.cwd).sessionStorage;
  } catch {
    return Config.SubagentSessionStorage.Nested;
  }
}

function resolveSupervisor(
  ctx: ExecutionTypes.SubagentParentContext,
  options: ExecutionTypes.RunSubagentOptions,
): Control.SubagentRunSupervisor {
  if (options.supervisor) return options.supervisor;
  const sessionId = ctx.sessionManager.getSessionId();
  let config;
  try {
    config = Config.loadSubagentRuntimeConfig(ctx.cwd);
  } catch {
    config = Config.resolveSubagentRuntimeConfig({});
  }
  return Control.getOrCreateSubagentRunSupervisor(sessionId, config);
}

function withSubagentTelemetry(
  options: ExecutionTypes.RunSubagentOptions,
  workflowWith: (
    runtime: Tooling.ToolingTelemetryRuntime,
  ) => Effect.Effect<
    AgentToolResult<Types.SubagentDetails>,
    Errors.SubagentExecutionError | Control.SubagentAdmissionError
  >,
): Effect.Effect<
  AgentToolResult<Types.SubagentDetails>,
  Errors.SubagentExecutionError | Control.SubagentAdmissionError
> {
  if (options.telemetryRuntime) {
    return options.telemetryRuntime.provide(workflowWith(options.telemetryRuntime));
  }

  return Tooling.withToolingTelemetryRuntime(
    {
      env: options.env ?? process.env,
      exporter: options.telemetryExporter,
      serviceName: SUBAGENT_TELEMETRY_SERVICE_NAME,
    },
    workflowWith,
  ).pipe(
    Effect.catchTag("ToolingOtelConfigError", () =>
      Effect.fail(executionError(Errors.SubagentExecutionPhase.Session)),
    ),
  );
}

export function runResolvedSubagentEffect(
  run: ExecutionTypes.ResolvedSubagentRun,
  ctx: ExecutionTypes.SubagentParentContext,
  options: ExecutionTypes.RunSubagentOptions = {},
): Effect.Effect<
  AgentToolResult<Types.SubagentDetails>,
  Errors.SubagentExecutionError | Control.SubagentAdmissionError
> {
  return withSubagentTelemetry(options, (runtime) =>
    runtime.diagnostics.span(
      "tooling.subagent.run",
      { operation: "run", mode: options.executionMode ?? Usage.SubagentUsageMode.Sync },
      Effect.callback<
        AgentToolResult<Types.SubagentDetails>,
        Errors.SubagentExecutionError | Control.SubagentAdmissionError
      >((resume) => {
        let child: NativeChild.NativeChildOwner | undefined;
        const work = (async () => {
          const persistent = createPersistentSubagentSession(
            run.name,
            ctx,
            run.cwd,
            options.sessionStorage ?? resolveSessionStorage(ctx),
          );
          const supervisor = resolveSupervisor(ctx, options);
          child = new NativeChild.NativeChildOwner(run, ctx, persistent.manager, supervisor, options);
          try {
            supervisor.retainChild(child);
            options.onChild?.(child);
            const result = await child.runInitial();
            return Usage.recordSubagentResult(
              options.ledger,
              options.runId,
              options.executionMode ?? Usage.SubagentUsageMode.Sync,
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
                error instanceof Control.SubagentAdmissionError
                  ? error
                  : executionError(Errors.SubagentExecutionPhase.Session, error),
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
  params: Resolver.SubagentParams,
  ctx: ExecutionTypes.SubagentParentContext,
  options: ExecutionTypes.RunSubagentOptions = {},
): Effect.Effect<
  AgentToolResult<Types.SubagentDetails>,
  Errors.SubagentExecutionError | Control.SubagentAdmissionError
> {
  return Effect.suspend(() => {
    const plan = Resolver.resolveSubagentExecutionPlan(params, ctx);
    if (!Resolver.isResolutionOk(plan))
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
