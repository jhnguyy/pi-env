import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SUBAGENT_LIMITS, type SubagentRuntimeConfig } from "../config";
import {
  formatJobMetadata,
  formatJobResult,
  SubagentJobManager,
  type SubagentJobRunner,
} from "../jobs";
import { zeroUsage } from "../usage";

function config(overrides: Partial<SubagentRuntimeConfig> = {}): SubagentRuntimeConfig {
  return {
    ...DEFAULT_SUBAGENT_LIMITS,
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

function manager(runner: SubagentJobRunner, overrides: Partial<SubagentRuntimeConfig> = {}) {
  return new SubagentJobManager(
    { appendEntry: () => {} } as any,
    new Map(),
    runner,
    undefined,
    undefined,
    config(overrides),
  );
}

describe("asynchronous subagent hardening", () => {
  it("bounds terminal retention and explicit result retrieval", async () => {
    const output = "x".repeat(10_000);
    const jobs = manager((params) => Effect.succeed(result(params.name ?? "large", output)), {
      maxResultBytes: 128,
      maxRetainedJobs: 2,
    });
    const started = Array.from({ length: 3 }, (_, index) =>
      jobs.start({ name: `large-${index}`, task: "task" }, {} as any),
    );
    await Promise.all(started.map((job) => jobs.wait(job.id)));

    expect(jobs.list()).toHaveLength(2);
    const retained = jobs.list().at(-1)!;
    expect(formatJobMetadata(retained)).not.toContain("x".repeat(20));
    expect(formatJobResult(retained)).toContain("Output truncated");
    expect(Buffer.byteLength(retained.resultText ?? "", "utf8")).toBeLessThan(512);
    expect(retained.resultTruncated).toBe(true);
    await jobs.shutdown();
  });

  it("reports cancelling until settlement and interrupts after the deadline", async () => {
    let settle!: () => void;
    const cooperative: SubagentJobRunner = (params, _ctx, _tools, options) =>
      Effect.callback((resume) => {
        settle = () => resume(Effect.succeed(result(params.name ?? "cancel")));
        options.signal?.addEventListener("abort", () => {}, { once: true });
      });
    const cooperativeJobs = manager(cooperative, { cancellationGraceMs: 1_000 });
    const cooperativeJob = cooperativeJobs.start({ name: "cancel", task: "task" }, {} as any);
    await expect.poll(() => cooperativeJob.status).toBe("running");
    cooperativeJobs.cancel(cooperativeJob.id);
    expect(cooperativeJob.status).toBe("cancelling");
    settle();
    await cooperativeJobs.wait(cooperativeJob.id);
    expect(cooperativeJob.status).toBe("cancelled");
    await cooperativeJobs.shutdown();

    const stuckJobs = manager(() => Effect.callback(() => Effect.void), {
      cancellationGraceMs: 10,
    });
    const stuck = stuckJobs.start({ name: "stuck", task: "task" }, {} as any);
    await expect.poll(() => stuck.status).toBe("running");
    stuckJobs.cancel(stuck.id);
    await stuckJobs.wait(stuck.id);
    expect(stuck.status).toBe("interrupted");
    await stuckJobs.shutdown();
  });

  it("settles active jobs and does not launch an already aborted start", async () => {
    const activeJobs = manager(() => Effect.callback(() => Effect.void), {
      cancellationGraceMs: 10,
    });
    const active = activeJobs.start({ name: "branch", task: "task" }, {} as any);
    await expect.poll(() => active.status).toBe("running");
    await activeJobs.settle();
    expect(active.status).toBe("interrupted");
    await activeJobs.shutdown();

    let runCount = 0;
    const abortedJobs = manager(() => {
      runCount++;
      return Effect.succeed(result("unexpected"));
    });
    const controller = new AbortController();
    controller.abort();
    const aborted = abortedJobs.start(
      { name: "aborted", task: "task" },
      {} as any,
      controller.signal,
    );
    await abortedJobs.wait(aborted.id);
    expect(aborted.status).toBe("cancelled");
    expect(runCount).toBe(0);
    await abortedJobs.shutdown();
  });
});
