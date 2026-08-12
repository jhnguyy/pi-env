import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Result } from "effect";

import {
  createPersistentSubagentSession,
  getSubagentSessionName,
  hasReachedTurnLimit,
} from "../execute";
import { SubagentJobManager } from "../jobs";
import { SubagentUsageLedger, zeroUsage } from "../usage";

class TestProviderUnavailable extends Data.TaggedError("TestProviderUnavailable")<{
  readonly message: string;
}> {}

describe("persistent subagent sessions", () => {
  it("names child sessions with a sub- prefix", () => {
    expect(getSubagentSessionName("Recon: Auth Flow")).toBe("sub-recon-auth-flow");
  });

  it("stores a child session beside its parent and links the parent header", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-subagent-session-"));
    try {
      const parent = SessionManager.create("/tmp/project", sessionDir);
      const child = createPersistentSubagentSession("audit", {
        cwd: "/tmp/project",
        sessionManager: parent,
      } as any);

      expect(child.file).toBeDefined();
      expect(child.manager.getSessionDir()).toBe(parent.getSessionDir());
      expect(child.manager.getHeader()?.parentSession).toBe(parent.getSessionFile());
      expect(child.manager.getSessionName()).toBe("sub-audit");
      expect(child.manager.getBranch().map((entry) => entry.type)).toEqual([
        "session_info",
        "thinking_level_change",
      ]);
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("does not impose a turn limit unless the caller selects one", () => {
    expect(hasReachedTurnLimit(1_000, undefined)).toBe(false);
    expect(hasReachedTurnLimit(2, 3)).toBe(false);
    expect(hasReachedTurnLimit(3, 3)).toBe(true);
  });

  it("tracks an asynchronous job through its durable lifecycle entries", async () => {
    const entries: Array<{ customType: string; data: any }> = [];
    const jobs = new SubagentJobManager(
      {
        appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
      } as any,
      new Map(),
      undefined,
    );
    const job = jobs.start({ name: "invalid", task: "x" }, {
      cwd: "/tmp/project",
      modelRegistry: {},
    } as any);

    await jobs.wait(job.id);
    expect(job.status).toBe("failed");
    expect(entries.map((entry) => entry.data.status)).toEqual(["queued", "failed"]);
  });

  it("marks default job execution as asynchronous without changing custom runner ownership", async () => {
    let executionMode: string | undefined;
    const runner = (_params: any, _ctx: any, _tools: any, options: any) => {
      executionMode = options.executionMode;
      return Effect.succeed({
        content: [],
        details: {
          name: "mode",
          task: "x",
          toolNames: [],
          modelOverride: undefined,
          finalOutput: "",
          toolCallCount: 0,
          usage: zeroUsage(),
          isError: false,
          turnLimitExceeded: false,
        },
      });
    };
    const jobs = new SubagentJobManager({ appendEntry: () => {} } as any, new Map(), runner);
    const job = jobs.start({ name: "mode", task: "x" }, {} as any);

    await jobs.wait(job.id);

    expect(executionMode).toBe("async");
    await jobs.shutdown();
  });

  it("records unexpected Effect failures for later status inspection", async () => {
    const entries: Array<{ data: any }> = [];
    const runner = () =>
      Effect.fail(new TestProviderUnavailable({ message: "provider unavailable" }));
    const jobs = new SubagentJobManager(
      {
        appendEntry: (_type: string, data: any) => entries.push({ data }),
      } as any,
      new Map(),
      runner,
    );
    const job = jobs.start({ name: "failure", task: "x" }, {} as any);

    await jobs.wait(job.id);

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toBe("TestProviderUnavailable");
    expect(entries.at(-1)?.data.errorMessage).toBe("TestProviderUnavailable");
  });

  it("interrupts a wait without cancelling the job", async () => {
    const runner = (_params: any, _ctx: any, _tools: any, options: any) =>
      Effect.callback<any>((resume) => {
        const onAbort = () => resume(Effect.succeed({ content: [], details: { isError: true } }));
        options.signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => options.signal.removeEventListener("abort", onAbort));
      });
    const jobs = new SubagentJobManager({ appendEntry: () => {} } as any, new Map(), runner);
    const job = jobs.start({ name: "long", task: "x" }, {} as any);
    const waitController = new AbortController();
    waitController.abort();

    const outcome = await Effect.runPromise(
      Effect.result(jobs.waitEffect(job.id, waitController.signal)),
    );
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure).toMatchObject({ _tag: "SubagentJobWaitInterrupted", jobId: job.id });
    }
    expect(job.status === "queued" || job.status === "running").toBe(true);
    await jobs.shutdown();
    expect(job.status).toBe("cancelled");
  });

  it("is safe under concurrent shutdown and post-shutdown start", async () => {
    const runner = () => Effect.callback<any>(() => Effect.sync(() => undefined));
    const jobs = new SubagentJobManager({ appendEntry: () => {} } as any, new Map(), runner);
    const running = jobs.start({ name: "running", task: "x" }, {} as any);
    await expect.poll(() => running.status).toBe("running");
    await Promise.all([jobs.shutdown(), jobs.shutdown()]);
    const late = jobs.start({ name: "late", task: "x" }, {} as any);
    expect(late.status).toBe("rejected");
    expect(running.status).toBe("interrupted");
  });

  it("does not double count async usage when cancellation races with progress", async () => {
    const ledger = new SubagentUsageLedger();
    const runner = (_params: any, _ctx: any, _tools: any, options: any) =>
      Effect.callback<any>((resume) => {
        options.onUsage({
          name: "race",
          task: "x",
          toolNames: [],
          modelOverride: undefined,
          finalOutput: "partial",
          toolCallCount: 0,
          usage: { ...zeroUsage(), input: 3, output: 4, turns: 1 },
          isError: false,
          turnLimitExceeded: false,
        });
        const onAbort = () =>
          resume(
            Effect.succeed({
              content: [{ type: "text", text: "cancelled" }],
              details: {
                name: "race",
                task: "x",
                toolNames: [],
                modelOverride: undefined,
                finalOutput: "partial",
                toolCallCount: 0,
                usage: { ...zeroUsage(), input: 3, output: 4, turns: 1 },
                isError: true,
                turnLimitExceeded: false,
              },
            }),
          );
        options.signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => options.signal.removeEventListener("abort", onAbort));
      });
    const jobs = new SubagentJobManager(
      { appendEntry: () => {} } as any,
      new Map(),
      runner,
      ledger,
    );
    const job = jobs.start({ name: "race", task: "x" }, {} as any);
    await expect.poll(() => job.latestDetails?.usage.input).toBe(3);

    jobs.cancel(job.id);
    await jobs.wait(job.id);
    ledger.record(job.id, "async", job.latestDetails!);

    expect(ledger.rows()).toHaveLength(1);
    expect(ledger.total()).toMatchObject({ input: 3, output: 4, turns: 1 });
  });

  it("waits for running jobs to record cancellation during shutdown", async () => {
    const entries: Array<{ data: any }> = [];
    const runner = (_params: any, _ctx: any, _tools: any, options: any) =>
      Effect.callback<any>((resume) => {
        const onAbort = () => resume(Effect.succeed({ content: [], details: { isError: true } }));
        options.signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => options.signal.removeEventListener("abort", onAbort));
      });
    const jobs = new SubagentJobManager(
      {
        appendEntry: (_type: string, data: any) => entries.push({ data }),
      } as any,
      new Map(),
      runner,
    );
    const job = jobs.start({ name: "shutdown", task: "x" }, {} as any);

    await jobs.shutdown();

    expect(job.status).toBe("cancelled");
    expect(entries.at(-1)?.data.status).toBe("cancelled");
  });
});
