import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";

import {
  makeToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { readOptionalAgentSettings } from "../_shared/agent-settings";
import { loadSubagentRuntimeConfig, resolveSubagentRuntimeConfig, type SubagentRuntimeConfig } from "./config";
import {
  disposeSubagentRunSupervisor,
  getOrCreateSubagentRunSupervisor,
  SubagentAdmissionError,
  type SubagentRunSupervisor,
} from "./control";
import {
  buildErrorDetails,
  runSubagentEffect,
  SUBAGENT_TELEMETRY_SERVICE_NAME,
} from "./execute";
import {
  SubagentJobManager,
  type SubagentJob,
  type SubagentJobReceipt,
} from "./jobs";
import { isResolutionOk, resolveEffectiveCwd, type SubagentParams } from "./resolver";
import {
  SubagentJobStatus,
  SubagentSessionState,
  type SubagentDetails,
  type SubagentJobRenderDetails,
  type SubagentSessionState as SubagentSessionStateValue,
} from "./types";
import { formatUsageCompact, SubagentUsageLedger } from "./usage";

function restoredUsage(value: unknown): SubagentDetails["usage"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const;
  if (
    !keys.every(
      (key) =>
        typeof candidate[key] === "number" &&
        Number.isFinite(candidate[key]) &&
        (candidate[key] as number) >= 0,
    )
  ) {
    return undefined;
  }
  return candidate as unknown as SubagentDetails["usage"];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function receiptFromEntry(entry: any, cwd: string): SubagentJobReceipt | undefined {
  if (entry.type !== "custom" || entry.customType !== "subagent-job") return undefined;
  const value = entry.data as Partial<SubagentJobReceipt> | undefined;
  const status = value?.status;
  if (
    !value ||
    typeof value.jobId !== "string" ||
    typeof status !== "string" ||
    !Object.values(SubagentJobStatus).includes(status)
  ) {
    return undefined;
  }
  return {
    jobId: value.jobId,
    name: optionalString(value.name) ?? "unnamed",
    task: optionalString(value.task) ?? "(task unavailable)",
    status,
    cwd: optionalString(value.cwd) ?? cwd,
    sessionFile: optionalString(value.sessionFile),
    usage: restoredUsage(value.usage),
    errorMessage: optionalString(value.errorMessage),
    resultText: optionalString(value.resultText),
    resultTruncated: value.resultTruncated === true,
    createdAt: optionalString(value.createdAt) ?? entry.timestamp,
    finishedAt: optionalString(value.finishedAt),
  };
}

function restoredReceipts(ctx: ExtensionContext): SubagentJobReceipt[] {
  const latest = new Map<string, SubagentJobReceipt>();
  for (const entry of ctx.sessionManager.getBranch()) {
    const receipt = receiptFromEntry(entry, ctx.cwd);
    if (receipt) latest.set(receipt.jobId, receipt);
  }
  return [...latest.values()];
}

export class SubagentSessionRuntime {
  private readonly ledger = new SubagentUsageLedger();
  private telemetryRuntime: ToolingTelemetryRuntime | undefined;
  private supervisor: SubagentRunSupervisor | undefined;
  private supervisorSessionId: string | undefined;
  private jobs: SubagentJobManager | undefined;
  private sessionState: SubagentSessionStateValue = SubagentSessionState.Inactive;
  private lifecycleGeneration = 0;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  ) {}

  get state(): SubagentSessionStateValue {
    return this.sessionState;
  }

  readonly execute = (
    toolCallId: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentDetails>> =>
    Effect.runPromise(
      Effect.catch(
        runSubagentEffect(params, ctx, this.registeredExtTools, {
          signal,
          onUpdate,
          ledger: this.ledger,
          runId: toolCallId,
          supervisor: this.supervisor,
          telemetryRuntime:
            this.sessionState === SubagentSessionState.Active ? this.telemetryRuntime : undefined,
        }),
        (error) => {
          const reason =
            error instanceof SubagentAdmissionError ? `admission_${error.reason}` : error.phase;
          const details = buildErrorDetails(params, [], params.model, reason);
          details.errorMessage = error.message;
          return Effect.succeed({
            content: [{ type: "text", text: `${error.message}.` }],
            details,
          });
        },
      ),
    );

  startSession(ctx: ExtensionContext): Promise<boolean> {
    const generation = ++this.lifecycleGeneration;
    this.sessionState = SubagentSessionState.ShuttingDown;
    return this.enqueueTransition(async () => {
      await this.disposeActiveResources();
      if (generation !== this.lifecycleGeneration) return false;

      const nextRuntime = await Effect.runPromise(
        makeToolingTelemetryRuntime({
          env: process.env,
          serviceName: SUBAGENT_TELEMETRY_SERVICE_NAME,
        }),
      );
      if (generation !== this.lifecycleGeneration) {
        await this.disposeTelemetry(nextRuntime);
        return false;
      }

      const settings = readOptionalAgentSettings(undefined, ctx.cwd);
      const enabledModels = Array.isArray(settings?.enabledModels) ? settings.enabledModels : [];
      let config: SubagentRuntimeConfig;
      try {
        config = loadSubagentRuntimeConfig(ctx.cwd, enabledModels);
      } catch {
        config = resolveSubagentRuntimeConfig({}, enabledModels);
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const supervisor = getOrCreateSubagentRunSupervisor(sessionId, config);

      this.ledger.clear();
      this.telemetryRuntime = nextRuntime;
      this.supervisor = supervisor;
      this.supervisorSessionId = sessionId;
      this.jobs = new SubagentJobManager(
        this.pi,
        this.registeredExtTools,
        undefined,
        this.ledger,
        nextRuntime,
        config,
        restoredReceipts(ctx),
      );
      this.sessionState = SubagentSessionState.Active;
      return true;
    });
  }

  shutdownSession(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.sessionState = SubagentSessionState.ShuttingDown;
    return this.enqueueTransition(async () => {
      await this.disposeActiveResources();
      if (generation === this.lifecycleGeneration) {
        this.ledger.clear();
        this.sessionState = SubagentSessionState.Inactive;
      }
    });
  }

  startJob(
    params: SubagentParams,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): AgentToolResult<SubagentJobRenderDetails> {
    if (this.sessionState !== SubagentSessionState.Active || !this.jobs) {
      return {
        content: [
          { type: "text", text: "Cannot start a subagent job without an active parent session." },
        ],
        details: { status: this.sessionState, name: params.name, task: params.task },
      };
    }
    const cwd = resolveEffectiveCwd(params, ctx.cwd);
    if (!isResolutionOk(cwd)) {
      return {
        content: [{ type: "text", text: cwd.error.message }],
        details: { status: cwd.error.reason, name: params.name, task: params.task },
      };
    }
    const normalizedParams = { ...params, cwd: cwd.value };
    const job = this.jobs.start(normalizedParams, ctx, signal);
    const message =
      job.status === SubagentJobStatus.Rejected
        ? `Rejected subagent job ${job.id} (${job.name}): ${job.errorMessage ?? "capacity unavailable"}.`
        : `Started subagent job ${job.id} (${job.name}).`;
    return {
      content: [{ type: "text", text: message }],
      details: { jobId: job.id, status: job.status, name: job.name, task: job.task },
    };
  }

  listJobs(): SubagentJob[] {
    return this.jobs?.list() ?? [];
  }

  getJob(id: string): SubagentJob | undefined {
    return this.jobs?.get(id);
  }

  async waitJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly job: SubagentJob | undefined; readonly interrupted: boolean }> {
    const manager = this.jobs;
    if (!manager) return { job: undefined, interrupted: false };
    const outcome = await Effect.runPromise(Effect.result(manager.waitEffect(id, signal)));
    return Result.isFailure(outcome)
      ? { job: manager.get(id), interrupted: true }
      : { job: outcome.success, interrupted: false };
  }

  cancelJob(id: string): SubagentJob | undefined {
    return this.jobs?.cancel(id);
  }

  async settleJobsBeforeTreeNavigation(): Promise<void> {
    await this.jobs?.settle();
  }

  usageText(): string {
    if (!this.supervisor) return this.ledger.render();
    const usage = this.supervisor.usage();
    if (
      usage.input === 0 &&
      usage.output === 0 &&
      usage.cacheRead === 0 &&
      usage.cacheWrite === 0 &&
      usage.turns === 0 &&
      usage.cost === 0
    ) {
      return "No subagent usage recorded.";
    }
    return `session: ${formatUsageCompact(usage)}`;
  }

  private enqueueTransition<T>(run: () => Promise<T>): Promise<T> {
    const next = this.transitionTail.then(run, run);
    this.transitionTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async disposeActiveResources(): Promise<void> {
    const manager = this.jobs;
    const runtime = this.telemetryRuntime;
    const supervisorSessionId = this.supervisorSessionId;
    try {
      await manager?.shutdown();
      if (supervisorSessionId) await disposeSubagentRunSupervisor(supervisorSessionId);
    } finally {
      this.jobs = undefined;
      this.supervisor = undefined;
      this.supervisorSessionId = undefined;
      this.telemetryRuntime = undefined;
      if (runtime) await this.disposeTelemetry(runtime);
    }
  }

  private disposeTelemetry(runtime: ToolingTelemetryRuntime): Promise<void> {
    return Effect.runPromise(runtime.disposeEffect);
  }
}
