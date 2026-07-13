import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Result } from "effect";

import {
  makeToolingTelemetryRuntime,
  type ToolingTelemetryRuntime,
} from "../../../src/telemetry/tooling";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import {
  buildErrorDetails,
  runSubagentEffect,
  SUBAGENT_TELEMETRY_SERVICE_NAME,
} from "./execute";
import { SubagentJobManager, type SubagentJob } from "./jobs";
import { isResolutionOk, resolveEffectiveCwd, type SubagentParams } from "./resolver";
import {
  SubagentSessionState,
  type SubagentDetails,
  type SubagentJobRenderDetails,
  type SubagentSessionState as SubagentSessionStateValue,
} from "./types";
import { SubagentUsageLedger } from "./usage";

export class SubagentSessionRuntime {
  private readonly ledger = new SubagentUsageLedger();
  private telemetryRuntime: ToolingTelemetryRuntime | undefined;
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
          telemetryRuntime:
            this.sessionState === SubagentSessionState.Active ? this.telemetryRuntime : undefined,
        }),
        (error) => {
          const details = buildErrorDetails(params, [], params.model, error.phase);
          details.errorMessage = error.message;
          return Effect.succeed({
            content: [{ type: "text", text: `${error.message}.` }],
            details,
          });
        },
      ),
    );

  startSession(): Promise<boolean> {
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

      this.ledger.clear();
      this.telemetryRuntime = nextRuntime;
      this.jobs = new SubagentJobManager(
        this.pi,
        this.registeredExtTools,
        undefined,
        this.ledger,
        nextRuntime,
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
    const job = this.jobs.start(normalizedParams, ctx);
    return {
      content: [{ type: "text", text: `Started subagent job ${job.id} (${job.name}).` }],
      details: { jobId: job.id, status: job.status, name: job.name, task: params.task },
    };
  }

  listJobs(): SubagentJob[] {
    return this.sessionState === SubagentSessionState.Active ? (this.jobs?.list() ?? []) : [];
  }

  getJob(id: string): SubagentJob | undefined {
    return this.sessionState === SubagentSessionState.Active ? this.jobs?.get(id) : undefined;
  }

  async waitJob(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly job: SubagentJob | undefined; readonly interrupted: boolean }> {
    const manager =
      this.sessionState === SubagentSessionState.Active ? this.jobs : undefined;
    if (!manager) return { job: undefined, interrupted: false };
    const outcome = await Effect.runPromise(Effect.result(manager.waitEffect(id, signal)));
    return Result.isFailure(outcome)
      ? { job: manager.get(id), interrupted: true }
      : { job: outcome.success, interrupted: false };
  }

  cancelJob(id: string): SubagentJob | undefined {
    return this.sessionState === SubagentSessionState.Active
      ? this.jobs?.cancel(id)
      : undefined;
  }

  usageText(): string {
    return this.ledger.render();
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
    this.jobs = undefined;
    this.telemetryRuntime = undefined;
    try {
      await manager?.shutdown();
    } finally {
      if (runtime) await this.disposeTelemetry(runtime);
    }
  }

  private disposeTelemetry(runtime: ToolingTelemetryRuntime): Promise<void> {
    return Effect.runPromise(runtime.disposeEffect);
  }
}
