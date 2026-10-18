import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SUBAGENT_CONFIG, type SubagentRuntimeConfig } from "../config";
import * as Control from "../control";
import * as ChildTypes from "../child-types";

function config(overrides: Partial<SubagentRuntimeConfig> = {}): SubagentRuntimeConfig {
  return {
    ...DEFAULT_SUBAGENT_CONFIG,
    maxConcurrentRuns: 2,
    maxPendingRuns: 2,
    ...overrides,
  };
}

function request(
  cwd: string,
  workspaceAccess: (typeof Control.WorkspaceAccess)[keyof typeof Control.WorkspaceAccess] = Control.WorkspaceAccess.Read,
) {
  return { cwd, workspaceAccess };
}

describe("shared subagent run supervisor", () => {
  it.each([true, false])("reports rejected eviction cleanup at shutdown even when closed=%s", async (closedAfterFailure) => {
    // Native shutdown hooks report through the SDK instead of reliably rejecting dispose.
    // Inject that failure at the owner's existing close port to test supervisor recovery.
    const supervisor = new Control.SubagentRunSupervisor("eviction-failure", config({ maxRetainedJobs: 1 }));
    const failure = new Error("native disposal failed");
    let closed = false;
    const child = (id: string, broken: boolean) => ({
      id, runId: id,
      summary: () => ({ id, runId: id, name: id, task: "task", cwd: "/fixture", sessionFile: undefined, model: undefined, state: broken && closed ? ChildTypes.NativeChildState.Closed : ChildTypes.NativeChildState.Idle }),
      inspect: () => { throw new Error("unused inspection"); },
      input: async () => { throw new Error("unused input"); },
      cancel: async () => {},
      close: async () => { if (broken) { closed = closedAfterFailure; throw failure; } },
    });
    supervisor.retainChild(child("broken", true));
    supervisor.retainChild(child("retained", false));
    supervisor.pruneChildren();
    await Promise.resolve();
    await Promise.resolve();
    await expect(supervisor.shutdown()).rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({ cause: failure })]) });
  });
  it("coalesces parent disposal until held work settles without reopening admission", async () => {
    // Hold admission directly: this isolates coordinator disposal, not native SDK execution.
    const supervisor = Control.getOrCreateSubagentRunSupervisor("coalesced-dispose", config());
    const lease = await supervisor.acquire(request("/coalesced"));
    let secondFinished = false;
    const first = Control.disposeSubagentRunSupervisor("coalesced-dispose");
    const second = Control.disposeSubagentRunSupervisor("coalesced-dispose").then(() => { secondFinished = true; });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(secondFinished).toBe(false);
      expect(Control.getOrCreateSubagentRunSupervisor("coalesced-dispose", config())).toBe(supervisor);
      await expect(supervisor.acquire(request("/late"))).rejects.toMatchObject({reason:"closed"});
    } finally {
      lease.release();
      await Promise.all([first,second]);
    }
    expect(Control.getSubagentRunSupervisor("coalesced-dispose")).toBeUndefined();
  });

  it("bounds shared admission and removes an aborted pending run", async () => {
    const supervisor = new Control.SubagentRunSupervisor(
      "session",
      config({ maxConcurrentRuns: 1, maxPendingRuns: 1 }),
    );
    const active = await supervisor.acquire(request("/active"));
    const controller = new AbortController();
    const pending = supervisor.acquire({ ...request("/pending"), signal: controller.signal });
    await expect(supervisor.acquire(request("/full"))).rejects.toMatchObject({
      reason: "capacity",
    });

    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
    active.release();

    const replacement = await supervisor.acquire(request("/replacement"));
    replacement.release();
    await supervisor.shutdown();
  });

  it("removes a pending admission when its Effect is interrupted", async () => {
    const supervisor = new Control.SubagentRunSupervisor(
      "session",
      config({ maxConcurrentRuns: 1, maxPendingRuns: 1 }),
    );
    const active = await supervisor.acquire(request("/active"));
    const controller = new AbortController();
    const pending = Effect.runPromise(supervisor.acquireEffect(request("/pending")), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    active.release();
    const replacement = await supervisor.acquire(request("/replacement"));
    replacement.release();
    await supervisor.shutdown();
  });

  it("allows shared reads and serializes writes by canonical workspace key", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-supervisor-workspace-"));
    const child = join(workspace, "packages", "child");
    mkdirSync(join(workspace, ".git"));
    mkdirSync(child, { recursive: true });
    const supervisor = new Control.SubagentRunSupervisor("session", config());

    const firstWrite = await supervisor.acquire(request(workspace, Control.WorkspaceAccess.Write));
    let secondWriteStarted = false;
    const secondWrite = supervisor.acquire(request(child, Control.WorkspaceAccess.Write)).then((lease) => {
      secondWriteStarted = true;
      return lease;
    });
    const sharedRead = await supervisor.acquire(request(child));
    expect(secondWriteStarted).toBe(false);

    sharedRead.release();
    firstWrite.release();
    const secondWriteLease = await secondWrite;
    expect(secondWriteStarted).toBe(true);
    secondWriteLease.release();
    await supervisor.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reports aggregate usage across sibling runs without enforcing a limit", async () => {
    const supervisor = new Control.SubagentRunSupervisor("session", config());
    const first = await supervisor.acquire({ ...request("/first"), runId: "dag:first" });
    const second = await supervisor.acquire({ ...request("/second"), runId: "dag:second" });
    first.updateUsage({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0, cost: 2, turns: 2 });
    second.updateUsage({ input: 41, output: 10, cacheRead: 0, cacheWrite: 0, cost: 2, turns: 2 });
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(supervisor.usage("dag:")).toMatchObject({ input: 81, output: 20, cost: 4 });
    first.release();
    second.release();
    await supervisor.shutdown();
  });

  it("aborts a run at its wall-time limit", async () => {
    vi.useFakeTimers();
    try {
      const supervisor = new Control.SubagentRunSupervisor("session", config({ maxRunMs: 20 }));
      const lease = await supervisor.acquire(request("/timed"));
      expect(lease.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(lease.signal.aborted).toBe(true);
      lease.release();
      await supervisor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
