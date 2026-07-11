/** In-process asynchronous subagent job registry. Jobs are cancelled with their parent session. */

import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Data, Effect } from "effect";

import { runSubagent } from "./execute";
import type { SubagentParams } from "./resolver";
import type { SubagentDetails, ToolCapability } from "./types";

export const MAX_CONCURRENT_SUBAGENT_JOBS = 4;
export const SubagentJobStatus = {
  Queued: "queued",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type SubagentJobStatus = typeof SubagentJobStatus[keyof typeof SubagentJobStatus];

const SubagentJobPhase = { Run: "run" } as const;
type SubagentJobPhase = typeof SubagentJobPhase[keyof typeof SubagentJobPhase];

class SubagentJobError extends Data.TaggedError("SubagentJobError")<{
  readonly phase: SubagentJobPhase;
  readonly cause: unknown;
}> {}

interface SubagentJob {
  id: string;
  name: string;
  status: SubagentJobStatus;
  controller: AbortController;
  params: SubagentParams;
  ctx: ExtensionContext;
  result?: AgentToolResult<SubagentDetails>;
  promise: Promise<void>;
  resolve: () => void;
}

export class SubagentJobManager {
  private readonly jobs = new Map<string, SubagentJob>();
  private activeCount = 0;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registeredExtTools: Map<string, AgentTool<any, any>>,
    private readonly registeredExtCaps: Map<string, ToolCapability[]> | undefined,
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

  async wait(id: string): Promise<SubagentJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    await job.promise;
    return job;
  }

  cancel(id: string): SubagentJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === SubagentJobStatus.Queued) {
      job.status = SubagentJobStatus.Cancelled;
      job.resolve();
      this.record(job);
    } else if (job.status === SubagentJobStatus.Running) {
      job.controller.abort();
    }
    return job;
  }

  shutdown(): void {
    for (const job of this.jobs.values()) this.cancel(job.id);
  }

  private async pump(): Promise<void> {
    while (this.activeCount < MAX_CONCURRENT_SUBAGENT_JOBS) {
      const job = this.list().find((candidate) => candidate.status === SubagentJobStatus.Queued);
      if (!job) return;
      this.activeCount++;
      job.status = SubagentJobStatus.Running;
      this.record(job);
      void this.run(job);
    }
  }

  private runEffect(job: SubagentJob): Effect.Effect<void, never> {
    const run = Effect.tryPromise({
      try: () => runSubagent(job.params, job.ctx, this.registeredExtTools, this.registeredExtCaps, {
        signal: job.controller.signal,
      }),
      catch: (cause) => new SubagentJobError({ phase: SubagentJobPhase.Run, cause }),
    });
    return Effect.asVoid(Effect.catchAll(
      Effect.tap(run, (result) => Effect.sync(() => {
        job.result = result;
        job.status = job.controller.signal.aborted
          ? SubagentJobStatus.Cancelled
          : result.details.isError ? SubagentJobStatus.Failed : SubagentJobStatus.Completed;
      })),
      (error) => Effect.sync(() => {
        job.status = job.controller.signal.aborted ? SubagentJobStatus.Cancelled : SubagentJobStatus.Failed;
        this.record(job, error.cause instanceof Error ? error.cause.message : String(error.cause));
      }),
    ));
  }

  private async run(job: SubagentJob): Promise<void> {
    try {
      await Effect.runPromise(this.runEffect(job));
    } finally {
      this.record(job);
      job.resolve();
      this.activeCount--;
      void this.pump();
    }
  }

  private record(job: SubagentJob, errorMessage?: string): void {
    this.pi.appendEntry("subagent-job", {
      jobId: job.id,
      name: job.name,
      status: job.status,
      sessionFile: job.result?.details.sessionFile,
      errorMessage,
    });
  }
}

export function renderJob(job: SubagentJob): string {
  const session = job.result?.details.sessionFile ? `\nsession: ${job.result.details.sessionFile}` : "";
  const output = job.result?.content[0];
  const text = output?.type === "text" ? output.text : "";
  return `[${job.status}] ${job.id} ${job.name}${session}${text ? `\n${text}` : ""}`;
}
