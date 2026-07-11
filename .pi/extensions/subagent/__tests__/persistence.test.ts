import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";

import {
  createPersistentSubagentSession,
  getSubagentSessionName,
  hasReachedTurnLimit,
} from "../execute";
import { SubagentJobManager } from "../jobs";

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
    const jobs = new SubagentJobManager({
      appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    } as any, new Map(), undefined);
    const job = jobs.start({ name: "invalid", task: "x" }, {
      cwd: "/tmp/project",
      modelRegistry: {},
    } as any);

    expect(job.status === "queued" || job.status === "running").toBe(true);
    await jobs.wait(job.id);
    expect(job.status).toBe("failed");
    expect(entries.map((entry) => entry.data.status)).toEqual(["queued", "running", "failed"]);
  });

  it("records unexpected Effect failures for later status inspection", async () => {
    const entries: Array<{ data: any }> = [];
    const runner = () => Effect.fail(new Error("provider unavailable"));
    const jobs = new SubagentJobManager({
      appendEntry: (_type: string, data: any) => entries.push({ data }),
    } as any, new Map(), undefined, runner);
    const job = jobs.start({ name: "failure", task: "x" }, {} as any);

    await jobs.wait(job.id);

    expect(job.status).toBe("failed");
    expect(job.errorMessage).toContain("provider unavailable");
    expect(entries.at(-1)?.data.errorMessage).toContain("provider unavailable");
  });

  it("interrupts a wait without cancelling the job", async () => {
    const runner = (_params: any, _ctx: any, _tools: any, _caps: any, options: any) => Effect.async<any>((resume) => {
      const onAbort = () => resume(Effect.succeed({ content: [], details: { isError: true } }));
      options.signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => options.signal.removeEventListener("abort", onAbort));
    });
    const jobs = new SubagentJobManager({ appendEntry: () => {} } as any, new Map(), undefined, runner);
    const job = jobs.start({ name: "long", task: "x" }, {} as any);
    const waitController = new AbortController();
    waitController.abort();

    const outcome = await Effect.runPromise(Effect.either(jobs.waitEffect(job.id, waitController.signal)));
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toMatchObject({ _tag: "SubagentJobWaitInterrupted", jobId: job.id });
    }
    expect(job.status).toBe("running");
    await jobs.shutdown();
    expect(job.status).toBe("cancelled");
  });

  it("waits for running jobs to record cancellation during shutdown", async () => {
    const entries: Array<{ data: any }> = [];
    const runner = (_params: any, _ctx: any, _tools: any, _caps: any, options: any) => Effect.async<any>((resume) => {
      const onAbort = () => resume(Effect.succeed({ content: [], details: { isError: true } }));
      options.signal.addEventListener("abort", onAbort, { once: true });
      return Effect.sync(() => options.signal.removeEventListener("abort", onAbort));
    });
    const jobs = new SubagentJobManager({
      appendEntry: (_type: string, data: any) => entries.push({ data }),
    } as any, new Map(), undefined, runner);
    const job = jobs.start({ name: "shutdown", task: "x" }, {} as any);

    await jobs.shutdown();

    expect(job.status).toBe("cancelled");
    expect(entries.at(-1)?.data.status).toBe("cancelled");
  });
});
