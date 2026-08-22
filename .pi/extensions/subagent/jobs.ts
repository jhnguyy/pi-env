/** Session-scoped asynchronous subagent jobs with bounded retention and shared admission. */

import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Cause, Data, Deferred, Effect } from "effect";

import type { ToolingTelemetryRuntime } from "../../../src/telemetry/tooling";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { DEFAULT_SUBAGENT_LIMITS, type SubagentRuntimeConfig } from "./config";
import {
  getOrCreateSubagentRunSupervisor,
  SubagentAdmissionError,
  WorkspaceAccess,
  type SubagentRunSupervisor,
  type WorkspaceAccess as WorkspaceAccessValue,
} from "./control";
import { SubagentJobWaitInterrupted } from "./errors";
import { runSubagentEffect, type RunSubagentOptions } from "./execute";
import type { SubagentParams } from "./resolver";
import {
  SubagentJobStatus,
  type SubagentDetails,
  type SubagentJobStatus as SubagentJobStatusValue,
} from "./types";
import type { SubagentUsageLedger} from "./usage";
import { formatUsageCompact, SubagentUsageMode } from "./usage";

export const MAX_CONCURRENT_SUBAGENT_JOBS = DEFAULT_SUBAGENT_LIMITS.maxConcurrentRuns;
export { SubagentJobStatus } from "./types";

class SubagentCancellationDeadline extends Data.TaggedError("SubagentCancellationDeadline")<{}> {}

export interface SubagentJob {
  readonly id: string;
  readonly name: string;
  readonly task: string;
  readonly cwd: string;
  status: SubagentJobStatusValue;
  latestDetails?: SubagentDetails;
  resultText?: string;
  resultTruncated?: boolean;
  errorMessage?: string;
  workspaceAccess?: WorkspaceAccessValue;
  readonly done: Deferred.Deferred<void>;
  readonly cancelRequested: Deferred.Deferred<void>;
  readonly controller: AbortController;
  readonly createdAt: string;
  finishedAt?: string;
  startSignalCleanup?: () => void;
}

export type SubagentJobRunner = (
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions,
) => Effect.Effect<AgentToolResult<SubagentDetails>, unknown>;

function failureFromCause(cause: Cause.Cause<unknown>): unknown {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) return reason.error;
  }
  return undefined;
}

function safeJobFailureMessage(error: unknown): string {
  if (error instanceof SubagentAdmissionError) return error.message;
  if (error instanceof SubagentCancellationDeadline) return error._tag;
  if (typeof error === "object" && error !== null && "_tag" in error) {
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

function boundedText(
  text: string,
  config: SubagentRuntimeConfig,
): { text: string; truncated: boolean } {
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

function boundedTask(task: string): string {
  const bounded = truncateHead(task, { maxBytes: 4 * 1024, maxLines: 100 });
  return bounded.firstLineExceedsLimit ? utf8Head(task, 4 * 1024) : bounded.content;
}

function sanitizeDetails(details: SubagentDetails, resultText: string): SubagentDetails {
  return {
    ...details,
    task: boundedTask(details.task),
    finalOutput: resultText,
  };
}

/** Job state around the session supervisor, which owns all admission and concurrency. */
export class SubagentJobManager {
  private readonly jobs = new Map<string, SubagentJob>();
  private readonly supervisor: SubagentRunSupervisor;
  private shutdownStarted = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
    private readonly runJob: SubagentJobRunner = runSubagentEffect,
    private readonly ledger?: SubagentUsageLedger,
    private readonly telemetryRuntime?: ToolingTelemetryRuntime,
    private readonly config: SubagentRuntimeConfig = { ...DEFAULT_SUBAGENT_LIMITS },
    supervisor?: SubagentRunSupervisor,
  ) {
    this.supervisor =
      supervisor ?? getOrCreateSubagentRunSupervisor(`jobs-${randomUUID()}`, this.config);
  }

  start(params: SubagentParams, ctx: ExtensionContext, signal?: AbortSignal): SubagentJob {
    const id = randomUUID();
    const [done, cancelRequested] = Effect.runSync(
      Effect.all([Deferred.make<void>(), Deferred.make<void>()]),
    );
    const controller = new AbortController();
    const rejected = this.shutdownStarted;
    const job: SubagentJob = {
      id,
      name: params.name ?? "unnamed",
      task: boundedTask(params.task),
      cwd: params.cwd ?? ctx.cwd,
      status: rejected ? SubagentJobStatus.Rejected : SubagentJobStatus.Queued,
      errorMessage: rejected ? "Parent subagent session is shutting down." : undefined,
      done,
      cancelRequested,
      controller,
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
    if (job.status === SubagentJobStatus.Queued) {
      Effect.runFork(this.runEffect(job, params, ctx));
    }
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
        job.finishedAt = new Date().toISOString();
        job.errorMessage = "Cancelled before launch.";
        job.controller.abort();
        Effect.runSync(Deferred.succeed(job.cancelRequested, undefined));
        this.finish(job);
        break;
      case SubagentJobStatus.Running:
        job.status = SubagentJobStatus.Cancelling;
        job.controller.abort();
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
    this.shutdownPromise = this.settle();
    return this.shutdownPromise;
  }

  private runEffect(
    job: SubagentJob,
    params: SubagentParams,
    ctx: ExtensionContext,
  ): Effect.Effect<void> {
    const cancellationDeadline = Deferred.await(job.cancelRequested).pipe(
      Effect.andThen(Effect.sleep(this.config.cancellationGraceMs)),
      Effect.flatMap(() => Effect.fail(new SubagentCancellationDeadline())),
    );
    const onAdmitted = () => {
      if (job.status !== SubagentJobStatus.Queued) return;
      job.status = SubagentJobStatus.Running;
      this.record(job);
    };
    const onUsage = (details: SubagentDetails) => {
      job.latestDetails = sanitizeDetails(details, job.resultText ?? "");
    };
    const options: RunSubagentOptions = {
      signal: job.controller.signal,
      executionMode: SubagentUsageMode.Async,
      runId: job.id,
      supervisor: this.supervisor,
      telemetryRuntime: this.telemetryRuntime,
      onAdmitted,
      onUsage,
    };
    const run = (
      this.runJob === runSubagentEffect
        ? this.runJob(params, ctx, this.registeredExtTools, options)
        : Effect.acquireUseRelease(
            this.supervisor.acquireEffect({
              runId: job.id,
              cwd: job.cwd || process.cwd(),
              workspaceAccess: job.workspaceAccess ?? WorkspaceAccess.Read,
              signal: job.controller.signal,
            }),
            (lease) =>
              Effect.sync(onAdmitted).pipe(
                Effect.andThen(
                  this.runJob(params, ctx, this.registeredExtTools, {
                    ...options,
                    signal: lease.signal,
                    onUsage: (details) => {
                      lease.updateUsage(details.usage);
                      onUsage(details);
                    },
                  }),
                ),
                Effect.tap((result) => Effect.sync(() => lease.updateUsage(result.details.usage))),
              ),
            (lease) => Effect.sync(() => lease.release()),
          )
    ).pipe(Effect.raceFirst(cancellationDeadline));

    return Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.match(Effect.sandbox(run), {
          onSuccess: (result) => {
            if (job.status === SubagentJobStatus.Cancelled) return;
            const bounded = boundedText(
              result.content
                .filter(
                  (part): part is Extract<typeof part, { type: "text" }> => part.type === "text",
                )
                .map((part) => part.text)
                .join("\n"),
              this.config,
            );
            job.resultText = bounded.text;
            job.resultTruncated = bounded.truncated;
            const details = result.details as Partial<SubagentDetails>;
            if (typeof details.task === "string" && details.usage) {
              job.latestDetails = sanitizeDetails(result.details, bounded.text);
            }
            job.status = job.controller.signal.aborted
              ? SubagentJobStatus.Cancelled
              : details.stopReason === "aborted"
                ? SubagentJobStatus.Interrupted
                : details.isError
                  ? SubagentJobStatus.Failed
                  : SubagentJobStatus.Completed;
          },
          onFailure: (cause) => {
            if (job.status === SubagentJobStatus.Cancelled) return;
            const error = failureFromCause(cause);
            job.status =
              error instanceof SubagentAdmissionError
                ? job.controller.signal.aborted
                  ? SubagentJobStatus.Cancelled
                  : SubagentJobStatus.Rejected
                : error instanceof SubagentCancellationDeadline
                  ? SubagentJobStatus.Interrupted
                  : job.controller.signal.aborted
                    ? SubagentJobStatus.Cancelled
                    : SubagentJobStatus.Failed;
            job.errorMessage = safeJobFailureMessage(error);
          },
        }),
      () =>
        Effect.sync(() => {
          if (terminal(job.status) && job.finishedAt) return;
          if (
            job.status === SubagentJobStatus.Running ||
            job.status === SubagentJobStatus.Cancelling
          ) {
            job.status = SubagentJobStatus.Interrupted;
            job.errorMessage = "Subagent execution ended without a terminal result.";
          }
          job.finishedAt = new Date().toISOString();
          this.finish(job);
        }),
    );
  }

  private finish(job: SubagentJob): void {
    job.startSignalCleanup?.();
    job.startSignalCleanup = undefined;
    if (job.latestDetails) this.ledger?.record(job.id, SubagentUsageMode.Async, job.latestDetails);
    this.record(job);
    Effect.runSync(Deferred.succeed(job.done, undefined));
    this.pruneTerminalJobs();
  }

  private record(job: SubagentJob): void {
    this.pi.appendEntry("subagent-job", {
      jobId: job.id,
      name: job.name,
      task: job.task,
      status: job.status,
      cwd: job.cwd,
      sessionFile: job.latestDetails?.sessionFile,
      usage: job.latestDetails?.usage,
      errorMessage: job.errorMessage ?? job.latestDetails?.errorMessage,
      resultText: job.resultText,
      resultTruncated: job.resultTruncated,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    });
  }

  private pruneTerminalJobs(): void {
    const terminalJobs = [...this.jobs.values()]
      .filter((job) => terminal(job.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const removeCount = Math.max(0, terminalJobs.length - this.config.maxRetainedJobs);
    for (const job of terminalJobs.slice(0, removeCount)) this.jobs.delete(job.id);
  }
}

export function formatJobMetadata(job: SubagentJob): string {
  const details = job.latestDetails;
  const session = details?.sessionFile ? ` session:${details.sessionFile}` : "";
  const usage = details?.usage ? ` usage:${formatUsageCompact(details.usage)}` : "";
  const error = job.errorMessage ? ` error:${job.errorMessage}` : "";
  return `[${job.status}] ${job.id} ${job.name}${session}${usage}${error}`;
}

export function formatJobResult(job: SubagentJob): string {
  if (job.status === SubagentJobStatus.Completed) return job.resultText ?? "";
  return formatJobMetadata(job);
}

/** Compatibility alias. Metadata-only callers should use formatJobMetadata. */
export const formatJobToolContent = formatJobResult;
