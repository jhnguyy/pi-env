/** In-process asynchronous subagent job registry. Jobs are cancelled with their parent session. */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cause, Deferred, Effect, Exit, Queue, Scope } from "effect";

import type { ExtToolRegistration } from "../_shared/agent-tools";
import { SubagentJobWaitInterrupted } from "./errors";
import { runSubagentEffect, type RunSubagentOptions } from "./execute";
import type { SubagentParams } from "./resolver";
import type { SubagentDetails } from "./types";
import { formatUsageCompact, SubagentUsageLedger, SubagentUsageMode } from "./usage";

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
  params: SubagentParams;
  ctx: ExtensionContext;
  result?: AgentToolResult<SubagentDetails>;
  latestDetails?: SubagentDetails;
  errorMessage?: string;
  readonly done: Deferred.Deferred<void>;
  readonly cancelRequested: Deferred.Deferred<void>;
}

export type SubagentJobRunner = (
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions,
) => Effect.Effect<AgentToolResult<SubagentDetails>, unknown>;

/** Effect-owned FIFO scheduler scoped to one Pi session. */
export class SubagentJobManager {
  private readonly jobs = new Map<string, SubagentJob>();
  private readonly queue: Queue.Queue<string>;
  private readonly scope: Scope.Closeable;
  private shutdownStarted = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
    private readonly runJob: SubagentJobRunner = runSubagentEffect,
    private readonly ledger?: SubagentUsageLedger,
  ) {
    const [queue, scope] = Effect.runSync(Effect.all([Queue.unbounded<string>(), Scope.make()]));
    this.queue = queue;
    this.scope = scope;
    for (let index = 0; index < MAX_CONCURRENT_SUBAGENT_JOBS; index++) {
      Effect.runSync(Effect.forkIn(this.worker(), this.scope, { startImmediately: true }));
    }
  }

  start(params: SubagentParams, ctx: ExtensionContext): SubagentJob {
    const id = randomUUID().slice(0, 8);
    const [done, cancelRequested] = Effect.runSync(Effect.all([Deferred.make<void>(), Deferred.make<void>()]));
    const job: SubagentJob = {
      id,
      name: params.name ?? "unnamed",
      status: this.shutdownStarted ? SubagentJobStatus.Cancelled : SubagentJobStatus.Queued,
      params,
      ctx,
      done,
      cancelRequested,
    };
    this.jobs.set(id, job);
    this.record(job);
    if (this.shutdownStarted) {
      Effect.runSync(Deferred.succeed(job.cancelRequested, undefined));
      Effect.runSync(Deferred.succeed(job.done, undefined));
    } else {
      Effect.runSync(Queue.offer(this.queue, id));
    }
    return job;
  }

  get(id: string): SubagentJob | undefined { return this.jobs.get(id); }
  list(): SubagentJob[] { return [...this.jobs.values()]; }

  waitEffect(id: string, signal?: AbortSignal): Effect.Effect<SubagentJob | undefined, SubagentJobWaitInterrupted> {
    const job = this.jobs.get(id);
    if (!job) return Effect.sync(() => undefined);
    const waitForDone = Deferred.await(job.done).pipe(Effect.as(job));
    if (!signal) return waitForDone;

    return Effect.raceFirst(
      waitForDone,
      Effect.callback<never, SubagentJobWaitInterrupted>((resume) => {
        if (signal.aborted) {
          resume(Effect.fail(new SubagentJobWaitInterrupted({ jobId: id })));
          return;
        }
        const onAbort = () => resume(Effect.fail(new SubagentJobWaitInterrupted({ jobId: id })));
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      }),
    );
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
        this.record(job);
        Effect.runSync(Deferred.succeed(job.cancelRequested, undefined));
        Effect.runSync(Deferred.succeed(job.done, undefined));
        break;
      case SubagentJobStatus.Running:
        Effect.runSync(Deferred.succeed(job.cancelRequested, undefined));
        break;
      default:
        break;
    }
    return job;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownStarted = true;
    for (const job of this.jobs.values()) this.cancel(job.id);
    this.shutdownPromise = Effect.runPromise(Effect.gen({ self: this }, function* () {
      yield* Effect.all([...this.jobs.values()].map((job) => Deferred.await(job.done)), { discard: true });
      yield* Scope.close(this.scope, Exit.void);
    }));
    return this.shutdownPromise;
  }

  private worker(): Effect.Effect<void> {
    return Effect.forever(Effect.gen({ self: this }, function* () {
      const id = yield* Queue.take(this.queue);
      const job = this.jobs.get(id);
      const started = yield* Effect.sync(() => {
        if (this.shutdownStarted || !job || job.status !== SubagentJobStatus.Queued) return false;
        job.status = SubagentJobStatus.Running;
        this.record(job);
        return true;
      });
      if (job && started) yield* this.runEffect(job);
    }));
  }

  private runEffect(job: SubagentJob): Effect.Effect<void> {
    const controller = new AbortController();
    const cancel = Deferred.await(job.cancelRequested).pipe(Effect.tap(() => Effect.sync(() => controller.abort())), Effect.flatMap(() => Effect.interrupt));
    const run = this.runJob(job.params, job.ctx, this.registeredExtTools, {
      signal: controller.signal,
      onUsage: (details) => { job.latestDetails = details; },
    }).pipe(Effect.raceFirst(cancel));

    return Effect.acquireUseRelease(
      Effect.void,
      () => Effect.match(Effect.sandbox(Effect.onInterrupt(run, () => Effect.sync(() => {
        job.status = SubagentJobStatus.Cancelled;
        job.errorMessage = "Cancelled.";
      }))), {
        onSuccess: (result) => {
          job.result = result;
          job.latestDetails = result.details;
          job.status = controller.signal.aborted
            ? SubagentJobStatus.Cancelled
            : result.details.isError ? SubagentJobStatus.Failed : SubagentJobStatus.Completed;
        },
        onFailure: (cause) => {
          if (job.status !== SubagentJobStatus.Cancelled) {
            job.status = SubagentJobStatus.Failed;
            job.errorMessage = Cause.pretty(cause);
          }
        },
      }),
      () => Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => {
        if (job.status === SubagentJobStatus.Running) {
          job.status = SubagentJobStatus.Cancelled;
          job.errorMessage = "Cancelled.";
        }
        if (job.latestDetails) this.ledger?.record(job.id, SubagentUsageMode.Async, job.latestDetails);
        this.record(job);
        Effect.runSync(Deferred.succeed(job.done, undefined));
      }))),
    );
  }

  private record(job: SubagentJob): void {
    this.pi.appendEntry("subagent-job", {
      jobId: job.id,
      name: job.name,
      status: job.status,
      cwd: job.params.cwd ?? job.ctx.cwd,
      sessionFile: job.latestDetails?.sessionFile ?? job.result?.details.sessionFile,
      usage: job.latestDetails?.usage ?? job.result?.details.usage,
      errorMessage: job.errorMessage ?? job.latestDetails?.errorMessage ?? job.result?.details.errorMessage,
    });
  }
}

export function formatJobToolContent(job: SubagentJob): string {
  const details = job.latestDetails ?? job.result?.details;
  const session = details?.sessionFile ? `\nsession: ${details.sessionFile}` : "";
  const usage = details?.usage ? `\nusage: ${formatUsageCompact(details.usage)}` : "";
  const output = job.result?.content[0];
  const text = output?.type === "text" ? output.text : job.errorMessage ?? "";
  return `[${job.status}] ${job.id} ${job.name}${session}${usage}${text ? `\n${text}` : ""}`;
}
