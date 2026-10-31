import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import * as Tooling from "../../../src/telemetry/tooling";
import * as Errors from "./errors";
import * as Resolver from "./resolver";
import type * as Types from "./types";
import * as Usage from "./usage";
import { connectSubagentService, waitForOperation, type SubagentServiceConnection } from "./service-host";
import type { Receipt, Submit } from "../../../src/subagent-service/contract";
import type * as ExecutionTypes from "./execution-types";
export type { RunSubagentOptions, ResolvedSubagentRun, SubagentParentContext } from "./execution-types";
export type { NativeChildSession } from "./child-types";

export const SUBAGENT_TELEMETRY_SERVICE_NAME = "pi-env-subagent" as const;

export function buildErrorDetails(
  params: Resolver.SubagentParams,
  toolNames: string[],
  modelOverride: string | undefined,
  reason: string,
): Types.SubagentDetails {
  return {
    name: params.name ?? "unnamed", task: params.task, toolNames, modelOverride,
    cwd: params.cwd, finalOutput: "", toolCallCount: 0, usage: Usage.zeroUsage(),
    stopReason: reason, isError: true, turnLimitExceeded: false,
  };
}

function submission(run: ExecutionTypes.ResolvedSubagentRun, runId: string, requestId: string): Submit {
  return {
    requestId, runId, name: run.name, task: run.task, cwd: run.cwd,
    ...(run.modelOverride !== undefined ? { model: run.modelOverride } : {}),
    ...(run.systemPrompt !== undefined ? { systemPrompt: run.systemPrompt } : {}),
    ...(run.toolNames !== undefined ? { tools: [...run.toolNames] } : {}),
    ...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
    ...(run.maxTurns !== undefined ? { maxTurns: run.maxTurns } : {}),
    ...(run.workspaceAccess !== undefined ? { workspaceAccess: run.workspaceAccess } : {}),
    ...(run.reviewCapability !== undefined ? { capability: JSON.parse(JSON.stringify(run.reviewCapability)) } : {}),
  };
}

async function initialResult(connection: SubagentServiceConnection, receipt: Receipt, run: ExecutionTypes.ResolvedSubagentRun): Promise<AgentToolResult<Types.SubagentDetails>> {
  const result = await connection.view.resultFull({ operationId: receipt.operationId });
  if (result) return result;
  const operation = connection.view.snapshot.value.operations.find((item) => item.operationId === receipt.operationId);
  const details = buildErrorDetails({ name: run.name, task: run.task, cwd: run.cwd }, [...run.toolNames ?? []], run.modelOverride, operation?.status ?? "missing_result");
  details.errorMessage = "Child did not produce a settled initial result; interrupted effects are not retried.";
  return { content: [{ type: "text", text: details.errorMessage }], details };
}

function explicitCancellation(connection: SubagentServiceConnection, receipt: Receipt, requestId: string, signal?: AbortSignal) {
  let request: Promise<void> | undefined;
  const cancel = () => {
    request ??= connection.view.cancel({ requestId: `${requestId}:cancel`, operationId: receipt.operationId });
    void request.catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return {
    acknowledge: () => request,
    dispose: () => signal?.removeEventListener("abort", cancel),
  };
}

/** The only internal execution path. Native ownership and effects stay in the service. */
export function runResolvedSubagentEffect(
  run: ExecutionTypes.ResolvedSubagentRun,
  ctx: ExecutionTypes.SubagentParentContext,
  options: ExecutionTypes.RunSubagentOptions = {},
): Effect.Effect<AgentToolResult<Types.SubagentDetails>, Errors.SubagentExecutionError> {
  const execute = Effect.tryPromise({
    try: async () => {
      options.signal?.throwIfAborted();
      if (run.customTools?.length) throw new Error("Executable private tools cannot cross the service boundary; supply a service-owned capability.");
      const connection = options.serviceConnection ?? await connectSubagentService(ctx.sessionManager.getSessionId());
      try {
        const runId = options.runId ?? randomUUID();
        const requestId = options.requestId ?? runId;
        const receipt = await connection.view.submit(submission(run, runId, requestId));
        options.onAdmitted?.();
        // A tool's explicit abort requests cancellation. A dropped client or Effect waiter does not.
        const cancellation = explicitCancellation(connection, receipt, requestId, options.signal);
        try {
          await waitForOperation(connection, receipt.operationId);
          await cancellation.acknowledge();
          const result = await initialResult(connection, receipt, run);
          options.onUpdate?.(result);
          return Usage.recordSubagentResult(options.ledger, runId, options.executionMode ?? Usage.SubagentUsageMode.Sync, result);
        } finally { cancellation.dispose(); }
      } finally { if (!options.serviceConnection) await connection.close(); }
    },
    catch: (cause) => new Errors.SubagentExecutionError({
      phase: Errors.SubagentExecutionPhase.Session,
      message: cause instanceof Error ? cause.message : "Subagent service execution failed",
    }),
  });
  const traced = (runtime: Tooling.ToolingTelemetryRuntime) => runtime.diagnostics.span(
    "tooling.subagent.run", { operation: "run", mode: options.executionMode ?? Usage.SubagentUsageMode.Sync }, execute,
  );
  if (options.telemetryRuntime) return options.telemetryRuntime.provide(traced(options.telemetryRuntime));
  return Tooling.withToolingTelemetryRuntime({
    env: options.env ?? process.env, exporter: options.telemetryExporter, serviceName: SUBAGENT_TELEMETRY_SERVICE_NAME,
  }, traced).pipe(Effect.catchTag("ToolingOtelConfigError", (error) => Effect.fail(new Errors.SubagentExecutionError({
    phase: Errors.SubagentExecutionPhase.Session, message: error.message,
  }))));
}

export function runSubagentEffect(
  params: Resolver.SubagentParams,
  ctx: ExecutionTypes.SubagentParentContext,
  options: ExecutionTypes.RunSubagentOptions = {},
): Effect.Effect<AgentToolResult<Types.SubagentDetails>, Errors.SubagentExecutionError> {
  return Effect.suspend(() => {
    const plan = Resolver.resolveSubagentExecutionPlan(params, ctx);
    if (!Resolver.isResolutionOk(plan)) return Effect.succeed({
      content: [{ type: "text" as const, text: plan.error.message }],
      details: buildErrorDetails(params, plan.error.toolNames, plan.error.modelOverride, plan.error.reason),
    });
    return runResolvedSubagentEffect({
      name: params.name ?? "unnamed", task: params.task, cwd: plan.value.effectiveCwd,
      modelOverride: plan.value.modelOverride, systemPrompt: plan.value.systemPrompt,
      toolNames: plan.value.toolNames, workspaceAccess: plan.value.workspaceAccess,
    }, ctx, options);
  });
}
