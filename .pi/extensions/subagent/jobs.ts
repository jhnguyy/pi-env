/** In-process asynchronous subagent job registry. Jobs are cancelled with their parent session. */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Fiber } from "effect";

import type { ExtToolRegistration } from "../_shared/agent-tools";
import { SubagentJobWaitInterrupted } from "./errors";
import { runSubagentEffect, type RunSubagentOptions } from "./execute";
import type { SubagentParams } from "./resolver";
import type { SubagentDetails } from "./types";

export const MAX_CONCURRENT_SUBAGENT_JOBS = 4;
export const SubagentJobStatus = {
  Queued: "queued",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type SubagentJobStatus = typeof SubagentJobStatus[keyof typeof SubagentJobStatus];

export interface SubagentJob {
  id: string;
  name: string;
  status: SubagentJobStatus;
  controller: AbortController;
  params: SubagentParams;
  ctx: ExtensionContext;
  result?: AgentToolResult<SubagentDetails>;
  errorMessage?: string;
  fiber?: Fiber.RuntimeFiber<void>;
  promise: Promise<void>;
  resolve: () => void;
}

export type SubagentJobRunner = (
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions,
) => Effect.Effect<AgentToolResult<SubagentDetails>, unknown>;

/**
 * Owns job state and persistence. The scheduler is deliberately small and pure;
 * Effect owns asynchronous execution, interruption, and finalization.
 */
export class SubagentJobManager {
  private readonly jobs = new Map<string, SubagentJob>();
  private activeCount = 0;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
    private readonly runJob: SubagentJobRunner = runSubagentEffect,
  ) {}

  start(params: SubagentParams, ctx: ExtensionContext): SubagentJob {
    const id = randomUUID().slice(0, 8);
    let resolve = () => {};
    const job: SubagentJob = {
      id,
      name: params.name ?? "unnamed",
      status: SubagentJobStatus.Queued,
      controller: new AbortController(),
      params,
      ctx,
      promise: new Promise<void>((done) => { resolve = done; }),
      resolve: () => resolve(),
    };
    this.jobs.set(id, job);
    this.record(job);
    void this.pump();
    return job;
  }

  get(id: string): SubagentJob | undefined { return this.jobs.get(id); }
  list(): SubagentJob[] { return [...this.jobs.values()]; }

  waitEffect(id: string, signal?: AbortSignal): Effect.Effect<SubagentJob | undefined, SubagentJobWaitInterrupted> {
    const job = this.jobs.get(id);
    if (!job) return Effect.succeed(undefined);
    if (!signal) return Effect.as(Effect.promise(() => job.promise), job);

    return Effect.tryPromise({
      try: () => new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new SubagentJobWaitInterrupted({ jobId: id }));
          return;
        }
        const onAbort = () => reject(new SubagentJobWaitInterrupted({ jobId: id }));
        signal.addEventListener("abort", onAbort, { once: true });
        void job.promise.finally(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      }),
      catch: (cause) => cause instanceof SubagentJobWaitInterrupted
        ? cause
        : new SubagentJobWaitInterrupted({ jobId: id }),
    }).pipe(Effect.as(job));
  }

  wait(id: string, signal?: AbortSignal): Promise<SubagentJob | undefined> {
    return Effect.runPromise(this.waitEffect(id, signal));
  }

  cancel(id: string): SubagentJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    switch (job.status) {
      case SubagentJobStatus.Queued:
        job.status = SubagentJobStatus.Cancelled;
        job.resolve();
        this.record(job);
        break;
      case SubagentJobStatus.Running:
        job.controller.abort();
        if (job.fiber) void Effect.runFork(Fiber.interruptFork(job.fiber));
        break;
      default:
        break;
    }
    return job;
  }

  shutdownEffect(): Effect.Effect<void> {
    const manager = this;
    return Effect.gen(function* () {
      for (const job of manager.jobs.values()) manager.cancel(job.id);
      yield* Fiber.interruptAll(
        [...manager.jobs.values()]
          .flatMap((job) => job.fiber ? [job.fiber] : []),
      );
      yield* Effect.all(
        [...manager.jobs.values()].map((job) => Effect.promise(() => job.promise)),
        { discard: true },
      );
    });
  }

  shutdown(): Promise<void> {
    return Effect.runPromise(this.shutdownEffect());
  }

  private async pump(): Promise<void> {
    while (this.activeCount < MAX_CONCURRENT_SUBAGENT_JOBS) {
      const job = this.list().find((candidate) => candidate.status === SubagentJobStatus.Queued);
      if (!job) return;
      this.activeCount++;
      job.status = SubagentJobStatus.Running;
      this.record(job);
      job.fiber = Effect.runFork(this.runEffect(job));
    }
  }

  private runEffect(job: SubagentJob): Effect.Effect<void> {
    return Effect.acquireUseRelease(
      Effect.sync(() => undefined),
      () => Effect.match(Effect.sandbox(Effect.onInterrupt(
        this.runJob(job.params, job.ctx, this.registeredExtTools, {
          signal: job.controller.signal,
        }),
        () => Effect.sync(() => {
          job.status = SubagentJobStatus.Cancelled;
          job.errorMessage = "Cancelled.";
        }),
      )), {
        onSuccess: (result) => {
          job.result = result;
          job.status = job.controller.signal.aborted
            ? SubagentJobStatus.Cancelled
            : result.details.isError ? SubagentJobStatus.Failed : SubagentJobStatus.Completed;
        },
        onFailure: (cause) => {
          job.status = job.controller.signal.aborted
            ? SubagentJobStatus.Cancelled
            : SubagentJobStatus.Failed;
          job.errorMessage = Cause.pretty(cause);
        },
      }),
      () => Effect.zipRight(
        // Let the runner release its own resources before opening another slot.
        Effect.yieldNow(),
        Effect.sync(() => {
          this.record(job);
          job.resolve();
          this.activeCount--;
          void this.pump();
        }),
      ),
    );
  }

  private record(job: SubagentJob): void {
    this.pi.appendEntry("subagent-job", {
      jobId: job.id,
      name: job.name,
      status: job.status,
      sessionFile: job.result?.details.sessionFile,
      errorMessage: job.errorMessage ?? job.result?.details.errorMessage,
    });
  }
}

export function renderJob(job: SubagentJob): string {
  const session = job.result?.details.sessionFile ? `\nsession: ${job.result.details.sessionFile}` : "";
  const output = job.result?.content[0];
  const text = output?.type === "text" ? output.text : job.errorMessage ?? "";
  return `[${job.status}] ${job.id} ${job.name}${session}${text ? `\n${text}` : ""}`;
}
