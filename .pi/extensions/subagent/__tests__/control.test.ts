import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SUBAGENT_LIMITS, type SubagentRuntimeConfig } from "../config";
import { SubagentRunSupervisor, WorkspaceAccess } from "../control";

function config(overrides: Partial<SubagentRuntimeConfig> = {}): SubagentRuntimeConfig {
  return {
    ...DEFAULT_SUBAGENT_LIMITS,
    maxConcurrentRuns: 2,
    maxPendingRuns: 2,
    cancellationGraceMs: 10,
    ...overrides,
  };
}

function request(
  cwd: string,
  workspaceAccess: (typeof WorkspaceAccess)[keyof typeof WorkspaceAccess] = WorkspaceAccess.Read,
) {
  return { cwd, workspaceAccess };
}

describe("shared subagent run supervisor", () => {
  it("bounds shared admission and removes an aborted pending run", async () => {
    const supervisor = new SubagentRunSupervisor(
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

  it("allows shared reads and serializes writes by canonical workspace key", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-supervisor-workspace-"));
    const child = join(workspace, "packages", "child");
    mkdirSync(join(workspace, ".git"));
    mkdirSync(child, { recursive: true });
    const supervisor = new SubagentRunSupervisor("session", config());

    const firstWrite = await supervisor.acquire(request(workspace, WorkspaceAccess.Write));
    let secondWriteStarted = false;
    const secondWrite = supervisor.acquire(request(child, WorkspaceAccess.Write)).then((lease) => {
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

  it("aborts a run at its wall-time limit", async () => {
    vi.useFakeTimers();
    try {
      const supervisor = new SubagentRunSupervisor("session", config({ maxRunMs: 20 }));
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
