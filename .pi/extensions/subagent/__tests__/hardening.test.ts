import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SUBAGENT_LIMITS, type SubagentRuntimeConfig } from "../config";
import {
  formatJobMetadata,
  formatJobResult,
  SubagentJobManager,
  type SubagentJobRunner,
  type SubagentJobReceipt,
} from "../jobs";
import { zeroUsage } from "../usage";

function config(overrides: Partial<SubagentRuntimeConfig> = {}): SubagentRuntimeConfig {
  return {
    ...DEFAULT_SUBAGENT_LIMITS,
    allowedModels: undefined,
    cancellationGraceMs: 50,
    ...overrides,
  };
}

function result(name: string, output = "done") {
  return {
    content: [{ type: "text" as const, text: output }],
    details: {
      name,
      task: "task",
      toolNames: ["read"],
      modelOverride: "test/model",
      finalOutput: output,
      toolCallCount: 0,
      usage: zeroUsage(),
      isError: false,
      turnLimitExceeded: false,
    },
  };
}

function manager(
  runner: SubagentJobRunner,
  overrides: Partial<SubagentRuntimeConfig> = {},
  receipts: readonly SubagentJobReceipt[] = [],
) {
  return new SubagentJobManager(
    { appendEntry: () => {} } as any,
    new Map(),
    runner,
    undefined,
    undefined,
    config(overrides),
    receipts,
  );
}

describe("asynchronous subagent hardening", () => {
  it("bounds queued admission and terminal retention", async () => {
    const releases: Array<() => void> = [];
    const runner: SubagentJobRunner = (params) =>
      Effect.callback((resume) => {
        releases.push(() => resume(Effect.succeed(result(params.name ?? "job"))));
      });
    const jobs = manager(runner, { maxQueuedJobs: 6, maxRetainedJobs: 2 });
    const running = Array.from({ length: 4 }, (_, index) =>
      jobs.start({ name: `running-${index}`, task: "task" }, {} as any),
    );
    await expect.poll(() => releases.length).toBe(4);

    const queued = Array.from({ length: 6 }, (_, index) =>
      jobs.start({ name: `queued-${index}`, task: "task" }, {} as any),
    );
    const rejected = jobs.start({ name: "rejected", task: "task" }, {} as any);
    expect(queued.map((job) => job.status)).toEqual(Array(6).fill("queued"));
    expect(rejected.status).toBe("rejected");

    for (const job of queued) jobs.cancel(job.id);
    for (const release of releases) release();
    await Promise.all(running.map((job) => jobs.wait(job.id)));
    expect(jobs.list().filter((job) => !["queued", "running", "cancelling"].includes(job.status))).toHaveLength(2);
    await jobs.shutdown();
  });

  it("keeps list metadata-only and bounds explicit result retrieval", async () => {
    const output = "x".repeat(10_000);
    const jobs = manager((params) => Effect.succeed(result(params.name ?? "large", output)), {
      maxResultBytes: 128,
    });
    const job = jobs.start({ name: "large", task: "task" }, {} as any);
    await jobs.wait(job.id);

    expect(formatJobMetadata(job)).not.toContain("x".repeat(20));
    expect(formatJobResult(job)).toContain("Output truncated");
    expect(Buffer.byteLength(job.resultText ?? "", "utf8")).toBeLessThan(512);
    expect(job.resultTruncated).toBe(true);
    await jobs.shutdown();
  });

  it("releases the parent context when launch starts", async () => {
    let observedLaunch: unknown = "not-started";
    let release!: () => void;
    const jobs = manager(() =>
      Effect.callback((resume) => {
        const active = jobs.list()[0];
        observedLaunch = active?.launch;
        release = () => resume(Effect.succeed(result("context")));
      }),
    );
    const ctx = { marker: "parent-context" } as any;
    const job = jobs.start({ name: "context", task: "task" }, ctx);
    await expect.poll(() => job.status).toBe("running");

    expect(observedLaunch).toBeUndefined();
    release();
    await jobs.wait(job.id);
    expect(job.launch).toBeUndefined();
    await jobs.shutdown();
  });

  it("reports cancelling until cooperative child settlement", async () => {
    let aborted = false;
    let settle!: () => void;
    const runner: SubagentJobRunner = (params, _ctx, _tools, options) =>
      Effect.callback((resume) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
        }, { once: true });
        settle = () => resume(Effect.succeed(result(params.name ?? "cancel")));
      });
    const jobs = manager(runner, { cancellationGraceMs: 1_000 });
    const job = jobs.start({ name: "cancel", task: "task" }, {} as any);
    await expect.poll(() => job.status).toBe("running");

    jobs.cancel(job.id);
    expect(job.status).toBe("cancelling");
    await expect.poll(() => aborted).toBe(true);
    expect(job.status).toBe("cancelling");
    settle();
    await jobs.wait(job.id);
    expect(job.status).toBe("cancelled");
    await jobs.shutdown();
  });

  it("marks a non-cooperative child interrupted after the cancellation deadline", async () => {
    const jobs = manager(() => Effect.callback(() => Effect.void), { cancellationGraceMs: 10 });
    const job = jobs.start({ name: "stuck", task: "task" }, {} as any);
    await expect.poll(() => job.status).toBe("running");

    jobs.cancel(job.id);
    await jobs.wait(job.id);
    expect(job.status).toBe("interrupted");
    await jobs.shutdown();
  });

  it("settles active jobs before a parent branch can change", async () => {
    const jobs = manager(() => Effect.callback(() => Effect.void), { cancellationGraceMs: 10 });
    const job = jobs.start({ name: "branch", task: "task" }, {} as any);
    await expect.poll(() => job.status).toBe("running");

    await jobs.settle();
    expect(job.status).toBe("interrupted");
    await jobs.shutdown();
  });

  it("restores receipts without retry and interrupts unfinished work", async () => {
    let runCount = 0;
    const runner: SubagentJobRunner = () => {
      runCount++;
      return Effect.succeed(result("unexpected"));
    };
    const receipts: SubagentJobReceipt[] = [
      {
        jobId: "running-receipt",
        name: "running",
        task: "task",
        status: "running",
        cwd: "/tmp",
        createdAt: new Date(0).toISOString(),
      },
      {
        jobId: "completed-receipt",
        name: "completed",
        task: "task",
        status: "completed",
        cwd: "/tmp",
        resultText: "saved".repeat(20_000),
        createdAt: new Date(1).toISOString(),
        finishedAt: new Date(2).toISOString(),
      },
    ];
    const jobs = manager(runner, {}, receipts);

    expect(jobs.get("running-receipt")).toMatchObject({ status: "interrupted", restored: true });
    expect(jobs.get("completed-receipt")).toMatchObject({
      status: "completed",
      restored: true,
      resultTruncated: true,
    });
    expect(Buffer.byteLength(jobs.get("completed-receipt")?.resultText ?? "", "utf8")).toBeLessThan(
      DEFAULT_SUBAGENT_LIMITS.maxResultBytes + 256,
    );
    expect(runCount).toBe(0);
    await jobs.shutdown();
  });

  it("auto-cancels a start whose signal is already aborted", async () => {
    let runCount = 0;
    const jobs = manager(() => {
      runCount++;
      return Effect.succeed(result("unexpected"));
    });
    const controller = new AbortController();
    controller.abort();
    const job = jobs.start({ name: "aborted", task: "task" }, {} as any, controller.signal);

    await jobs.wait(job.id);
    expect(job.status).toBe("cancelled");
    expect(runCount).toBe(0);
    await jobs.shutdown();
  });
});
