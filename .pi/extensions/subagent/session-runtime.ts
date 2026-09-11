import { randomUUID } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";

import {
  createToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { clearSlot, setSlot } from "../_shared/ui-render";
import {
  DEFAULT_SUBAGENT_CONFIG,
  loadSubagentRuntimeConfig,
  resolveSubagentRuntimeConfig,
  type SubagentRuntimeConfig,
} from "./config";
import {
  disposeSubagentRunSupervisor,
  getOrCreateSubagentRunSupervisor,
  SubagentAdmissionError,
  type SubagentRunSupervisor,
} from "./control";
import { DagSessionRuntime, type DagSubagentExecutorRegistryFactory } from "./dag-session-runtime";
import {
  buildErrorDetails,
  runSubagentEffect,
  SUBAGENT_TELEMETRY_SERVICE_NAME,
  type RunSubagentOptions,
} from "./execute";
import { SubagentJobManager, type SubagentJob } from "./jobs";
import { isResolutionOk, resolveEffectiveCwd, type SubagentParams } from "./resolver";
import {
  SubagentJobStatus,
  SubagentSessionState,
  type SubagentDetails,
  type SubagentJobRenderDetails,
  type SubagentSessionState as SubagentSessionStateValue,
} from "./types";
import { formatUsageCompact, SubagentUsageLedger } from "./usage";

export interface SubagentSessionRuntimeDependencies {
  readonly agentLoop?: RunSubagentOptions["agentLoop"];
  readonly telemetryRuntimeFactory?: typeof createToolingTelemetryRuntime;
  readonly dagExecutorRegistryFactory?: DagSubagentExecutorRegistryFactory;
}

const ACTIVE_JOB_STATUSES = new Set<SubagentJobStatus>([
  SubagentJobStatus.Queued,
  SubagentJobStatus.Running,
  SubagentJobStatus.Cancelling,
]);

function briefJobName(name: string): string {
  const singleLine = name
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
  return singleLine.length > 48 ? `${singleLine.slice(0, 45)}...` : singleLine;
}

export function formatActiveJobStatusLines(
  jobs: readonly SubagentJob[],
  theme: ExtensionContext["ui"]["theme"],
): string[] {
  return jobs
    .filter((job) => ACTIVE_JOB_STATUSES.has(job.status))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((job) => {
      const color =
        job.status === SubagentJobStatus.Cancelling
          ? "warning"
          : job.status === SubagentJobStatus.Queued
            ? "dim"
            : "accent";
      return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", briefJobName(job.name))} ${theme.fg(color, `[${job.status}]`)}`;
    });
}

export function renderActiveJobStatusSlot(
  jobs: readonly SubagentJob[],
  ctx: ExtensionContext,
): void {
  if (!ctx.hasUI) return;
  const lines = formatActiveJobStatusLines(jobs, ctx.ui.theme);
  if (lines.length === 0) clearSlot("subagents", ctx);
  else setSlot("subagents", lines, ctx);
}

export class SubagentSessionRuntime {
  private readonly ledger = new SubagentUsageLedger();
  private telemetryRuntime: ToolingTelemetryRuntime | undefined;
  private supervisor: SubagentRunSupervisor | undefined;
  private supervisorSessionId: string | undefined;
  private sessionStorage: SubagentRuntimeConfig["sessionStorage"] =
    DEFAULT_SUBAGENT_CONFIG.sessionStorage;
  private jobs: SubagentJobManager | undefined;
  private dagRuntime: DagSessionRuntime | undefined;
  private sessionState: SubagentSessionStateValue = SubagentSessionState.Inactive;
  private lifecycleGeneration = 0;
  private transitionTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
    private readonly dependencies: SubagentSessionRuntimeDependencies = {},
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
          sessionStorage:
            this.sessionState === SubagentSessionState.Active ? this.sessionStorage : undefined,
          telemetryRuntime:
            this.sessionState === SubagentSessionState.Active ? this.telemetryRuntime : undefined,
          agentLoop: this.dependencies.agentLoop,
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
    clearSlot("subagents", ctx);
    this.dagRuntime?.stopAccepting();
    return this.enqueueTransition(async () => {
      await this.disposeActiveResources();
      if (generation !== this.lifecycleGeneration) return false;

      const nextRuntime = await Effect.runPromise(
        (this.dependencies.telemetryRuntimeFactory ?? createToolingTelemetryRuntime)({
          env: process.env,
          serviceName: SUBAGENT_TELEMETRY_SERVICE_NAME,
        }),
      );
      if (generation !== this.lifecycleGeneration) {
        await this.disposeTelemetry(nextRuntime);
        return false;
      }

      let config: SubagentRuntimeConfig;
      try {
        config = loadSubagentRuntimeConfig(ctx.cwd);
      } catch {
        config = resolveSubagentRuntimeConfig({});
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const supervisor = getOrCreateSubagentRunSupervisor(sessionId, config);

      const jobs = new SubagentJobManager(
        this.pi,
        this.registeredExtTools,
        undefined,
        this.ledger,
        nextRuntime,
        config,
        supervisor,
        (jobs) => this.updateJobStatusSlot(jobs, ctx),
        this.dependencies.agentLoop,
      );
      let dagRuntime: DagSessionRuntime;
      try {
        dagRuntime = await DagSessionRuntime.create(this.pi, ctx, this.registeredExtTools, {
          sessionGeneration: randomUUID(),
          supervisor,
          telemetryRuntime: nextRuntime,
          ledger: this.ledger,
          sessionStorage: config.sessionStorage,
          executorRegistryFactory: this.dependencies.dagExecutorRegistryFactory,
          agentLoop: this.dependencies.agentLoop,
        });
      } catch (cause) {
        await disposeSubagentRunSupervisor(sessionId);
        await this.disposeTelemetry(nextRuntime);
        throw cause;
      }
      if (generation !== this.lifecycleGeneration) {
        await dagRuntime.dispose();
        await disposeSubagentRunSupervisor(sessionId);
        await this.disposeTelemetry(nextRuntime);
        return false;
      }

      this.ledger.clear();
      this.telemetryRuntime = nextRuntime;
      this.supervisor = supervisor;
      this.supervisorSessionId = sessionId;
      this.sessionStorage = config.sessionStorage;
      this.jobs = jobs;
      this.dagRuntime = dagRuntime;
      this.sessionState = SubagentSessionState.Active;
      this.updateJobStatusSlot([], ctx);
      return true;
    });
  }

  shutdownSession(ctx?: ExtensionContext): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    this.sessionState = SubagentSessionState.ShuttingDown;
    if (ctx) clearSlot("subagents", ctx);
    this.dagRuntime?.stopAccepting();
    return this.enqueueTransition(async () => {
      try {
        await this.disposeActiveResources();
      } finally {
        if (generation === this.lifecycleGeneration) {
          this.ledger.clear();
          this.sessionState = SubagentSessionState.Inactive;
        }
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

  private updateJobStatusSlot(jobs: readonly SubagentJob[], ctx: ExtensionContext): void {
    if (this.sessionState !== SubagentSessionState.Active) {
      clearSlot("subagents", ctx);
      return;
    }
    renderActiveJobStatusSlot(jobs, ctx);
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
    const dagRuntime = this.dagRuntime;
    const runtime = this.telemetryRuntime;
    const supervisorSessionId = this.supervisorSessionId;
    const dagDisposal = dagRuntime?.dispose();
    let failure: unknown;
    const settle = async (operation: Promise<unknown> | undefined): Promise<void> => {
      try {
        await operation;
      } catch (cause) {
        failure ??= cause;
      }
    };

    await settle(manager?.shutdown());
    await settle(dagDisposal);
    await settle(
      supervisorSessionId ? disposeSubagentRunSupervisor(supervisorSessionId) : undefined,
    );
    this.jobs = undefined;
    this.dagRuntime = undefined;
    this.supervisor = undefined;
    this.supervisorSessionId = undefined;
    this.sessionStorage = DEFAULT_SUBAGENT_CONFIG.sessionStorage;
    this.telemetryRuntime = undefined;
    await settle(runtime ? this.disposeTelemetry(runtime) : undefined);
    if (failure !== undefined) throw failure;
  }

  private disposeTelemetry(runtime: ToolingTelemetryRuntime): Promise<void> {
    return Effect.runPromise(runtime.disposeEffect);
  }
}
