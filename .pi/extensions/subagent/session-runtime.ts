import { randomUUID } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import {
  createToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling";
import type { NativeChildSummary, NativeInputMode, NativeInputSource } from "./child-types";
import type {
  InspectionPage,
  InspectionOptions,
  Input,
} from "../../../src/subagent-service/contract";
import {
  buildErrorDetails,
  runSubagentEffect,
  submission,
  SUBAGENT_TELEMETRY_SERVICE_NAME,
} from "./execute";
import { projectJob, type SubagentJob } from "./jobs";
import { resolveSubagentExecutionPlan, isResolutionOk, type SubagentParams } from "./resolver";
import {
  connectSubagentService,
  waitForOperation,
  type SubagentServiceConnection,
} from "./service-host";
import { SubagentSessionState, type SubagentDetails, type SubagentJobRenderDetails } from "./types";
import { addUsage, formatUsageCompact, zeroUsage, SubagentUsageLedger } from "./usage";

export interface SubagentSessionRuntimeDependencies {
  readonly telemetryRuntimeFactory?: typeof createToolingTelemetryRuntime;
  readonly serviceConnectionFactory?: typeof connectSubagentService;
}

const activeStatuses = new Set(["queued", "running", "cancelling"]);
export function formatActiveJobStatusLines(
  jobs: readonly SubagentJob[],
  theme: ExtensionContext["ui"]["theme"],
): string[] {
  return jobs
    .filter((job) => activeStatuses.has(job.status))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((job) => {
      const name = job.name
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
      return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", name.length > 48 ? `${name.slice(0, 45)}...` : name)} ${theme.fg(job.status === "cancelling" ? "warning" : job.status === "queued" ? "dim" : "accent", `[${job.status}]`)}`;
    });
}
export function renderActiveJobStatusSlot(
  jobs: readonly SubagentJob[],
  ctx: ExtensionContext,
): void {
  if (!ctx.hasUI) return;
  const lines = formatActiveJobStatusLines(jobs, ctx.ui.theme);
  ctx.ui.setWidget("subagents", lines.length ? lines : undefined, { placement: "belowEditor" });
}

/** Parent-side views and transport only. Durable records and every child lifecycle belong to the service. */
export class SubagentSessionRuntime {
  private connection?: SubagentServiceConnection;
  private reconnecting?: Promise<SubagentServiceConnection>;
  private parentContext?: ExtensionContext;
  private stopUpdates?: () => void;
  private telemetryRuntime?: ToolingTelemetryRuntime;
  private sessionState: SubagentSessionState = SubagentSessionState.Inactive;
  private lifecycleGeneration = 0;
  private transitionTail: Promise<void> = Promise.resolve();
  private readonly ledger = new SubagentUsageLedger();
  private readonly pendingInputs = new Map<string, Input>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly dependencies: SubagentSessionRuntimeDependencies = {},
  ) {}
  get state(): SubagentSessionState {
    return this.sessionState;
  }
  private async service(): Promise<SubagentServiceConnection> {
    if (
      this.sessionState !== SubagentSessionState.Active ||
      !this.connection ||
      !this.parentContext
    )
      throw new Error("Parent subagent session is not active.");
    if (!this.connection.signal.aborted) return this.connection;
    const ctx = this.parentContext;
    const generation = this.lifecycleGeneration;
    this.reconnecting ??= (async () => {
      const next = await (this.dependencies.serviceConnectionFactory ?? connectSubagentService)(
        ctx.sessionManager.getSessionId(),
      );
      if (generation !== this.lifecycleGeneration) {
        await next.close();
        throw new Error("Parent session changed during reconnection.");
      }
      this.stopUpdates?.();
      this.connection = next;
      this.stopUpdates = next.view.snapshot.subscribe(() =>
        renderActiveJobStatusSlot(this.listJobs(), ctx),
      );
      return next;
    })();
    try {
      return await this.reconnecting;
    } finally {
      this.reconnecting = undefined;
    }
  }

  async assertConnected(): Promise<void> {
    await this.service();
  }

  readonly execute = async (
    toolCallId: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentDetails>> => {
    if (this.sessionState !== SubagentSessionState.Active)
      return {
        content: [{ type: "text", text: "Parent subagent session is not active." }],
        details: buildErrorDetails(params, [], params.model, "inactive"),
      };
    try {
      const result = await Effect.runPromise(
        runSubagentEffect(params, ctx, {
          runId: toolCallId,
          signal,
          onUpdate,
          ledger: this.ledger,
          telemetryRuntime: this.telemetryRuntime,
          serviceConnection: await this.service(),
        }),
      );
      const operation = this.connection?.view.snapshot.value.operations.find(
        (op) => op.runId === toolCallId && op.kind === "initial",
      );
      const text =
        result.details.finalOutput ||
        result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      const truncated = text.length > 4096;
      const preview = text.slice(0, 4096);
      return {
        ...result,
        content: [
          {
            type: "text",
            text:
              preview +
              (truncated
                ? `\n[More initial result: subagent result job_id=${operation?.operationId} offset=4096]`
                : ""),
          },
        ],
        details: {
          ...result.details,
          finalOutput: preview,
          jobId: operation?.operationId,
          childId: operation?.childId,
          resultTruncated: truncated,
        },
      };
    } catch (error) {
      const details = buildErrorDetails(params, [], params.model, "service");
      details.errorMessage = error instanceof Error ? error.message : "Subagent service failed";
      return { content: [{ type: "text", text: details.errorMessage }], details };
    }
  };

  listChildren(): NativeChildSummary[] {
    return (this.connection?.view.snapshot.value.children ?? []).map((child) => ({
      id: child.childId,
      runId: child.runId,
      name: child.name,
      task: child.task,
      cwd: child.cwd,
      sessionFile: child.sessionFile ?? undefined,
      model: child.model,
      state: child.state,
    }));
  }

  async inspectChild(
    id: string,
    options: InspectionOptions = {},
  ): Promise<InspectionPage | undefined> {
    const inspection = await (await this.service()).inspect(id);
    try {
      await inspection.refresh(options);
      return inspection.snapshot.value ?? undefined;
    } finally {
      inspection.release();
    }
  }

  async inputChild(
    id: string,
    text: string,
    mode: NativeInputMode,
    source: NativeInputSource = "human",
    requestId?: string,
  ) {
    const connection = await this.service();
    const key = JSON.stringify([id, text, mode, source, requestId]);
    let request = this.pendingInputs.get(key);
    if (!request) {
      if (this.pendingInputs.size >= 256)
        throw new Error(
          "Pending input capacity reached; reconcile unknown admissions before submitting more.",
        );
      request = { requestId: requestId ?? randomUUID(), childId: id, text, mode, source };
      this.pendingInputs.set(key, request);
    }
    // Retain this immutable request on lost acknowledgement. Retrying the same
    // browser draft never silently creates another operation.
    const receipt = await connection.view.input(request);
    await waitForOperation(connection, receipt.operationId);
    const result = await connection.view.result({ operationId: receipt.operationId });
    if (result.status !== "completed" && result.status !== "cancelled")
      throw new Error(result.text || `Child input ${result.status}`);
    this.pendingInputs.delete(key);
    return {
      ...receipt,
      result,
      outcome: result.disposition as "started" | "queued" | "handled",
      cancelled: result.status === "cancelled",
    };
  }

  async reopenChild(id: string, requestId: string = randomUUID()): Promise<void> {
    const connection = await this.service();
    const receipt = await connection.view.reopen({ childId: id, requestId });
    await waitForOperation(connection, receipt.operationId);
    const result = await connection.view.result({ operationId: receipt.operationId });
    if (result.status !== "completed") throw new Error(result.text || `Reopen ${result.status}`);
  }

  async cancelChild(id: string): Promise<void> {
    const connection = await this.service();
    const operations = connection.view.snapshot.value.operations.filter(
      (op) =>
        op.childId === id &&
        (op.kind === "initial" || op.kind === "prompt") &&
        (op.status === "accepted" || op.status === "dispatched"),
    );
    for (const op of operations)
      await connection.view.cancel({ requestId: randomUUID(), operationId: op.operationId });
    await Promise.all(operations.map((op) => waitForOperation(connection, op.operationId)));
  }

  startSession(ctx: ExtensionContext): Promise<boolean> {
    const generation = ++this.lifecycleGeneration;
    this.sessionState = SubagentSessionState.ShuttingDown;
    renderActiveJobStatusSlot([], ctx);
    return this.enqueue(async () => {
      await this.disposeResources();
      if (generation !== this.lifecycleGeneration) return false;
      const connection = await (
        this.dependencies.serviceConnectionFactory ?? connectSubagentService
      )(ctx.sessionManager.getSessionId());
      let telemetry: ToolingTelemetryRuntime;
      try {
        telemetry = await Effect.runPromise(
          (this.dependencies.telemetryRuntimeFactory ?? createToolingTelemetryRuntime)({
            env: process.env,
            serviceName: SUBAGENT_TELEMETRY_SERVICE_NAME,
          }),
        );
      } catch (error) {
        try {
          await connection.close();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "Subagent telemetry startup and client cleanup failed",
            { cause: cleanup },
          );
        }
        throw error;
      }
      try {
        if (generation !== this.lifecycleGeneration) {
          await connection.close();
          await Effect.runPromise(telemetry.disposeEffect);
          return false;
        }
        this.connection = connection;
        this.parentContext = ctx;
        this.telemetryRuntime = telemetry;
        this.sessionState = SubagentSessionState.Active;
        this.stopUpdates = connection.view.snapshot.subscribe(() =>
          renderActiveJobStatusSlot(this.listJobs(), ctx),
        );
        renderActiveJobStatusSlot(this.listJobs(), ctx);
        return true;
      } catch (error) {
        const outcomes = await Promise.allSettled([
          connection.close(),
          Effect.runPromise(telemetry.disposeEffect),
        ]);
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : [],
        );
        if (failures.length)
          throw new AggregateError([error, ...failures], "Subagent startup and cleanup failed", {
            cause: error,
          });
        throw error;
      }
    });
  }

  shutdownSession(ctx?: ExtensionContext): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.sessionState = SubagentSessionState.ShuttingDown;
    if (ctx) renderActiveJobStatusSlot([], ctx);
    return this.enqueue(async () => {
      try {
        await this.disposeResources();
      } finally {
        if (generation === this.lifecycleGeneration)
          this.sessionState = SubagentSessionState.Inactive;
      }
    });
  }

  async startJob(
    params: SubagentParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<AgentToolResult<SubagentJobRenderDetails>> {
    signal?.throwIfAborted();
    const connection = await this.service();
    const plan = resolveSubagentExecutionPlan(params, ctx);
    if (!isResolutionOk(plan))
      return {
        content: [{ type: "text", text: plan.error.message }],
        details: { status: plan.error.reason, name: params.name, task: params.task },
      };
    const runId = requestId;
    const receipt = await connection.view.submit(
      submission(
        {
          name: params.name ?? "unnamed",
          task: params.task,
          cwd: plan.value.effectiveCwd,
          modelOverride: plan.value.modelOverride,
          toolNames: plan.value.toolNames,
          systemPrompt: plan.value.systemPrompt,
        },
        runId,
        requestId,
      ),
    );
    // Admission is durable. Later caller abort or parent shutdown only disconnects the waiter.
    return {
      content: [
        {
          type: "text",
          text: `Started subagent job ${receipt.operationId} (${params.name}). Child ${receipt.childId}.`,
        },
      ],
      details: {
        jobId: receipt.operationId,
        childId: receipt.childId,
        status: "queued",
        name: params.name,
        task: params.task.slice(0, 256),
      },
    };
  }

  listJobs(): SubagentJob[] {
    const snapshot = this.connection?.view.snapshot.value;
    if (!snapshot) return [];
    const children = new Map(snapshot.children.map((child) => [child.childId, child]));
    return snapshot.operations
      .filter((op) => op.kind === "initial")
      .flatMap((op) => {
        const child = children.get(op.childId);
        return child ? [projectJob(op, child)] : [];
      });
  }
  getJob(id: string): SubagentJob | undefined {
    const snapshot = this.connection?.view.snapshot.value;
    const operation = snapshot?.operations.find((op) => op.operationId === id);
    const child =
      operation && snapshot?.children.find((item) => item.childId === operation.childId);
    return operation && child ? projectJob(operation, child) : undefined;
  }

  async resultJob(id: string, options: { offset?: number; limit?: number } = {}) {
    if (!this.getJob(id)) throw new Error(`Unknown subagent job: ${id}`);
    return (await this.service()).view.result({ operationId: id, ...options });
  }

  async waitJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly job: SubagentJob | undefined; readonly interrupted: boolean }> {
    if (!this.getJob(id)) return { job: undefined, interrupted: false };
    try {
      await waitForOperation(await this.service(), id, signal);
    } catch (error) {
      if (!signal?.aborted) throw error;
      return { job: this.getJob(id), interrupted: true };
    }
    return { job: this.getJob(id), interrupted: false };
  }
  async cancelJob(id: string): Promise<SubagentJob | undefined> {
    if (!this.getJob(id)) return undefined;
    await (await this.service()).view.cancel({ requestId: randomUUID(), operationId: id });
    return this.getJob(id);
  }

  async settleJobsBeforeTreeNavigation(): Promise<void> {
    // Navigation changes the parent view, never the lifetime of accepted service work.
  }

  usageText(): string {
    const usages = (this.connection?.view.snapshot.value.children ?? []).flatMap((child) =>
      child.usage ? [child.usage] : [],
    );
    return usages.length
      ? `session: ${formatUsageCompact(usages.reduce((total, usage) => addUsage(total, usage), zeroUsage()))}`
      : "No subagent usage recorded.";
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.transitionTail.then(run, run);
    this.transitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async disposeResources(): Promise<void> {
    this.stopUpdates?.();
    this.stopUpdates = undefined;
    const connection = this.connection;
    const telemetry = this.telemetryRuntime;
    this.connection = undefined;
    this.telemetryRuntime = undefined;
    const outcomes = await Promise.allSettled([
      connection?.close(),
      telemetry && Effect.runPromise(telemetry.disposeEffect),
    ]);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Subagent client cleanup failed");
  }
}
