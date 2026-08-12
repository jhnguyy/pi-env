/** Session-scoped asynchronous subagent jobs with bounded admission and retention. */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateHead, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Cause, Data, Deferred, Effect, Exit, Queue, Scope } from "effect";

import type { ExtToolRegistration } from "../_shared/agent-tools";
import type { ToolingTelemetryRuntime } from "../../../src/telemetry/tooling";
import { DEFAULT_SUBAGENT_LIMITS, type SubagentRuntimeConfig } from "./config";
import { SubagentJobWaitInterrupted } from "./errors";
import { runSubagentEffect, type RunSubagentOptions } from "./execute";
import type { SubagentParams } from "./resolver";
import {
  SubagentJobStatus,
  type SubagentDetails,
  type SubagentJobStatus as SubagentJobStatusValue,
} from "./types";
import { formatUsageCompact, SubagentUsageLedger, SubagentUsageMode } from "./usage";

export const MAX_CONCURRENT_SUBAGENT_JOBS = DEFAULT_SUBAGENT_LIMITS.maxConcurrentRuns;
export { SubagentJobStatus } from "./types";

class SubagentCancellationDeadline extends Data.TaggedError("SubagentCancellationDeadline")<{}> {}

export interface SubagentJobReceipt {
  readonly jobId: string;
  readonly name: string;
  readonly task: string;
  readonly status: SubagentJobStatusValue;
  readonly cwd: string;
  readonly sessionFile?: string;
  readonly usage?: SubagentDetails["usage"];
  readonly errorMessage?: string;
  readonly resultText?: string;
  readonly resultTruncated?: boolean;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

interface SubagentLaunch {
  readonly params: SubagentParams;
  readonly ctx: ExtensionContext;
}

export interface SubagentJob {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly cwd: string;
  status: SubagentJobStatusValue;
  launch?: SubagentLaunch;
  latestDetails?: SubagentDetails;
  resultText?: string;
  resultTruncated?: boolean;
  errorMessage?: string;
  readonly done: Deferred.Deferred<void>;
  readonly cancelRequested: Deferred.Deferred<void>;
  readonly createdAt: string;
  finishedAt?: string;
  restored?: boolean;
  startSignalCleanup?: () => void;
}

export type SubagentJobRunner = (
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions,
) => Effect.Effect<AgentToolResult<SubagentDetails>, unknown>;

function safeJobFailureMessage(cause: Cause.Cause<unknown>): string {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (error instanceof SubagentCancellationDeadline) return error._tag;
    if (typeof error !== "object" || error === null || !("_tag" in error)) continue;
    const tag = String(error._tag);
    if (/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tag)) return tag;
  }
  return "SubagentJobFailed";
}

function terminal(status: SubagentJobStatusValue): boolean {
  return ![
    SubagentJobStatus.Queued,
    SubagentJobStatus.Running,
    SubagentJobStatus.Cancelling,
  ].includes(status as any);
}

function utf8Head(text: string, maxBytes: number): string {
  return Buffer.from(text, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
}

function boundedText(text: string, config: SubagentRuntimeConfig): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= config.maxResultBytes) {
    return { text, truncated: false };
  }
  const suffix = "\n\n[Output truncated. Read the child session for the complete transcript.]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (config.maxResultBytes <= suffixBytes) {
    return { text: utf8Head(suffix.trimStart(), config.maxResultBytes), truncated: true };
  }
  const contentBudget = config.maxResultBytes - suffixBytes;
  const bounded = truncateHead(text, { maxBytes: contentBudget, maxLines: 2_000 });
  const content = bounded.firstLineExceedsLimit ? utf8Head(text, contentBudget) : bounded.content;
  return {
    text: bounded.truncated ? `${content}${suffix}` : content,
    truncated: bounded.truncated,
  };
}

function boundedTask(task: string, config: SubagentRuntimeConfig): string {
  const bounded = truncateHead(task, { maxBytes: config.maxTaskBytes, maxLines: 100 });
  return bounded.firstLineExceedsLimit ? utf8Head(task, config.maxTaskBytes) : bounded.content;
}

function sanitizeDetails(
  details: SubagentDetails,
  resultText: string,
  config: SubagentRuntimeConfig,
): SubagentDetails {
  return {
    ...details,
    task: boundedTask(details.task, config),
    finalOutput: resultText,
  };
}

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
    private readonly telemetryRuntime?: ToolingTelemetryRuntime,
    private readonly config: SubagentRuntimeConfig = {
      ...DEFAULT_SUBAGENT_LIMITS,
      allowedModels: undefined,
    },
    receipts: readonly SubagentJobReceipt[] = [],
  ) {
    const [queue, scope] = Effect.runSync(Effect.all([Queue.unbounded<string>(), Scope.make()]));
    this.queue = queue;
    this.scope = scope;
    this.restore(receipts);
    for (let index = 0; index < this.config.maxConcurrentRuns; index++) {
      Effect.runSync(Effect.forkIn(this.worker(), this.scope, { startImmediately: true }));
    }
  }

  start(params: SubagentParams, ctx: ExtensionContext, signal?: AbortSignal): SubagentJob {
    const id = randomUUID();
    const [done, cancelRequested] = Effect.runSync(
      Effect.all([Deferred.make<void>(), Deferred.make<void>()]),
    );
    const queuedCount = [...this.jobs.values()].filter(
      (job) => job.status === SubagentJobStatus.Queued,
    ).length;
    const rejected = this.shutdownStarted || queuedCount >= this.config.maxQueuedJobs;
    const job: SubagentJob = {
      id,
      name: params.name ?? "unnamed",
      task: boundedTask(params.task, this.config),
      cwd: params.cwd ?? ctx.cwd,
      status: rejected ? SubagentJobStatus.Rejected : SubagentJobStatus.Queued,
      launch: rejected ? undefined : { params, ctx },
      errorMessage: rejected
        ? this.shutdownStarted
          ? "Parent subagent session is shutting down."
          : "Subagent job queue is full."
        : undefined,
      done,
      cancelRequested,
      createdAt: new Date().toISOString(),
      finishedAt: rejected ? new Date().toISOString() : undefined,
    };
    this.jobs.set(id, job);
    this.record(job);
    if (rejected) {
      Effect.runSync(Deferred.succeed(job.cancelRequested, undefined));
      Effect.runSync(Deferred.succeed(job.done, undefined));
      this.pruneTerminalJobs();
      return job;
    }

    if (signal) {
      const onAbort = () => this.cancel(id);
      signal.addEventListener("abort", onAbort, { once: true });
      job.startSignalCleanup = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }
    if (job.status === SubagentJobStatus.Queued) Effect.runSync(Queue.offer(this.queue, id));
    return job;
  }

  get(id: string): SubagentJob | undefined {
    return this.jobs.get(id);
  }

  list(): SubagentJob[] {
    return [...this.jobs.values()];
  }

  waitEffect(
    id: string,
    signal?: AbortSignal,
  ): Effect.Effect<SubagentJob | undefined, SubagentJobWaitInterrupted> {
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
        job.launch = undefined;
        job.finishedAt = new Date().toISOString();
        job.errorMessage = "Cancelled before launch.";
        this.finish(job);
        break;
      case SubagentJobStatus.Running:
        job.status = SubagentJobStatus.Cancelling;
        this.record(job);
        Effect.runSync(Deferred.succeed(job.cancelRequested, undefined));
        break;
      default:
        break;
    }
    return job;
  }

  async settle(): Promise<void> {
    for (const job of this.jobs.values()) this.cancel(job.id);
    await Effect.runPromise(
      Effect.all(
        [...this.jobs.values()].map((job) => Deferred.await(job.done)),
        { discard: true },
      ),
    );
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownStarted = true;
    for (const job of this.jobs.values()) this.cancel(job.id);
    this.shutdownPromise = Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* Effect.all(
          [...this.jobs.values()].map((job) => Deferred.await(job.done)),
          { discard: true },
        );
        yield* Scope.close(this.scope, Exit.void);
      }),
    );
    return this.shutdownPromise;
  }

  receipt(job: SubagentJob): SubagentJobReceipt {
    const details = job.latestDetails;
    return {
      jobId: job.id,
      name: job.name,
      task: job.task,
      status: job.status,
      cwd: job.cwd,
      sessionFile: details?.sessionFile,
      usage: details?.usage,
      errorMessage: job.errorMessage ?? details?.errorMessage,
      resultText: job.resultText,
      resultTruncated: job.resultTruncated,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    };
  }

  private restore(receipts: readonly SubagentJobReceipt[]): void {
    for (const receipt of receipts.slice(-this.config.maxRetainedJobs)) {
      const [done, cancelRequested] = Effect.runSync(
        Effect.all([Deferred.make<void>(), Deferred.make<void>()]),
      );
      const status = terminal(receipt.status) ? receipt.status : SubagentJobStatus.Interrupted;
      const restoredResult = receipt.resultText
        ? boundedText(receipt.resultText, this.config)
        : undefined;
      const job: SubagentJob = {
        id: receipt.jobId,
        name: receipt.name,
        task: boundedTask(receipt.task, this.config),
        cwd: receipt.cwd,
        status,
        resultText: restoredResult?.text,
        resultTruncated: receipt.resultTruncated === true || restoredResult?.truncated === true,
        errorMessage:
          status === SubagentJobStatus.Interrupted
            ? "The parent process ended before this job reached a terminal state. Retry explicitly with a new job."
            : receipt.errorMessage,
        done,
        cancelRequested,
        createdAt: receipt.createdAt,
        finishedAt: receipt.finishedAt ?? new Date().toISOString(),
        restored: true,
        latestDetails: receipt.usage
          ? {
              name: receipt.name,
              task: boundedTask(receipt.task, this.config),
              toolNames: [],
              modelOverride: undefined,
              sessionFile: receipt.sessionFile,
              finalOutput: restoredResult?.text ?? "",
              toolCallCount: 0,
              usage: receipt.usage,
              isError: status !== SubagentJobStatus.Completed,
              turnLimitExceeded: false,
            }
          : undefined,
      };
      this.jobs.set(job.id, job);
      Effect.runSync(Deferred.succeed(job.cancelRequested, undefined));
      Effect.runSync(Deferred.succeed(job.done, undefined));
      if (status === SubagentJobStatus.Interrupted && status !== receipt.status) this.record(job);
    }
  }

  private worker(): Effect.Effect<void> {
    return Effect.forever(
      Effect.gen({ self: this }, function* () {
        const id = yield* Queue.take(this.queue);
        const job = this.jobs.get(id);
        const launch = yield* Effect.sync(() => {
          if (this.shutdownStarted || !job || job.status !== SubagentJobStatus.Queued) return undefined;
          const current = job.launch;
          if (!current) return undefined;
          job.launch = undefined;
          job.status = SubagentJobStatus.Running;
          this.record(job);
          return current;
        });
        if (job && launch) yield* this.runEffect(job, launch);
      }),
    );
  }

  private runEffect(job: SubagentJob, launch: SubagentLaunch): Effect.Effect<void> {
    const controller = new AbortController();
    const cancellationDeadline = Deferred.await(job.cancelRequested).pipe(
      Effect.tap(() => Effect.sync(() => controller.abort())),
      Effect.andThen(Effect.sleep(this.config.cancellationGraceMs)),
      Effect.flatMap(() => Effect.fail(new SubagentCancellationDeadline())),
    );
    const run = this.runJob(launch.params, launch.ctx, this.registeredExtTools, {
      signal: controller.signal,
      executionMode: SubagentUsageMode.Async,
      runId: job.id,
      telemetryRuntime: this.telemetryRuntime,
      onUsage: (details) => {
        job.latestDetails = sanitizeDetails(details, job.resultText ?? "", this.config);
      },
    }).pipe(Effect.raceFirst(cancellationDeadline));

    return Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.match(
          Effect.sandbox(run),
          {
            onSuccess: (result) => {
              const bounded = boundedText(
                result.content
                  .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
                this.config,
              );
              job.resultText = bounded.text;
              job.resultTruncated = bounded.truncated;
              const details = result.details as Partial<SubagentDetails>;
              if (typeof details.task === "string" && details.usage) {
                job.latestDetails = sanitizeDetails(
                  result.details,
                  bounded.text,
                  this.config,
                );
              }
              job.status = controller.signal.aborted
                ? SubagentJobStatus.Cancelled
                : details.stopReason === "aborted"
                  ? SubagentJobStatus.Interrupted
                  : details.isError
                    ? SubagentJobStatus.Failed
                    : SubagentJobStatus.Completed;
            },
            onFailure: (cause) => {
              const failure = safeJobFailureMessage(cause);
              job.status =
                failure === "SubagentCancellationDeadline"
                  ? SubagentJobStatus.Interrupted
                  : controller.signal.aborted
                    ? SubagentJobStatus.Cancelled
                    : SubagentJobStatus.Failed;
              job.errorMessage = failure;
            },
          },
        ),
      () =>
        Effect.sync(() => {
          if (job.status === SubagentJobStatus.Running || job.status === SubagentJobStatus.Cancelling) {
            job.status = SubagentJobStatus.Interrupted;
            job.errorMessage = "Subagent execution ended without a terminal result.";
          }
          job.finishedAt = new Date().toISOString();
          this.finish(job);
        }),
    );
  }

  private finish(job: SubagentJob): void {
    job.launch = undefined;
    job.startSignalCleanup?.();
    job.startSignalCleanup = undefined;
    if (job.latestDetails) this.ledger?.record(job.id, SubagentUsageMode.Async, job.latestDetails);
    this.record(job);
    Effect.runSync(Deferred.succeed(job.done, undefined));
    this.pruneTerminalJobs();
  }

  private pruneTerminalJobs(): void {
    const terminalJobs = [...this.jobs.values()]
      .filter((job) => terminal(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const removeCount = Math.max(0, terminalJobs.length - this.config.maxRetainedJobs);
    for (const job of terminalJobs.slice(0, removeCount)) this.jobs.delete(job.id);
  }

  private record(job: SubagentJob): void {
    this.pi.appendEntry("subagent-job", this.receipt(job));
  }
}

export function formatJobMetadata(job: SubagentJob): string {
  const details = job.latestDetails;
  const session = details?.sessionFile ? ` session:${details.sessionFile}` : "";
  const usage = details?.usage ? ` usage:${formatUsageCompact(details.usage)}` : "";
  const restored = job.restored ? " restored" : "";
  const error = job.errorMessage ? ` error:${job.errorMessage}` : "";
  return `[${job.status}] ${job.id} ${job.name}${session}${usage}${restored}${error}`;
}

export function formatJobResult(job: SubagentJob): string {
  return `${formatJobMetadata(job)}${job.resultText ? `\n${job.resultText}` : "\n(no result available; inspect the child session if present)"}`;
}

/** Compatibility alias. Metadata-only callers should use formatJobMetadata. */
export const formatJobToolContent = formatJobResult;
