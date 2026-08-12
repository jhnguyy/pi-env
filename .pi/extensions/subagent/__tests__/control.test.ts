import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SUBAGENT_LIMITS, type SubagentRuntimeConfig } from "../config";
import {
  SubagentAdmissionError,
  SubagentRunKind,
  SubagentRunOutcome,
  SubagentRunSupervisor,
  WorkspaceAccess,
} from "../control";
import { zeroUsage } from "../usage";

function config(overrides: Partial<SubagentRuntimeConfig> = {}): SubagentRuntimeConfig {
  return {
    ...DEFAULT_SUBAGENT_LIMITS,
    allowedModels: ["test/model"],
    maxConcurrentRuns: 2,
    maxPendingRuns: 2,
    cancellationGraceMs: 10,
    ...overrides,
  };
}

function request(
  kind: (typeof SubagentRunKind)[keyof typeof SubagentRunKind],
  cwd: string,
  workspaceAccess: (typeof WorkspaceAccess)[keyof typeof WorkspaceAccess],
) {
  return { kind, cwd, workspaceAccess, model: "test/model" };
}

describe("shared subagent run supervisor", () => {
  it("shares concurrency across sync, async, and direct runs", async () => {
    const supervisor = new SubagentRunSupervisor("session", config());
    const sync = await supervisor.acquire(request(SubagentRunKind.Sync, "/one", WorkspaceAccess.Read));
    const asyncRun = await supervisor.acquire(request(SubagentRunKind.Async, "/two", WorkspaceAccess.Read));
    let directStarted = false;
    const direct = supervisor
      .acquire(request(SubagentRunKind.Direct, "/three", WorkspaceAccess.Read))
      .then((lease) => {
        directStarted = true;
        return lease;
      });
    await Promise.resolve();
    expect(directStarted).toBe(false);

    sync.release(SubagentRunOutcome.Completed);
    const directLease = await direct;
    expect(directStarted).toBe(true);
    asyncRun.release(SubagentRunOutcome.Completed);
    directLease.release(SubagentRunOutcome.Completed);
    await supervisor.shutdown();
  });

  it("allows shared reads and serializes writes by canonical workspace key", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-supervisor-workspace-"));
    const child = join(workspace, "packages", "child");
    mkdirSync(join(workspace, ".git"));
    mkdirSync(child, { recursive: true });
    const supervisor = new SubagentRunSupervisor("session", config());
    const firstWrite = await supervisor.acquire(
      request(SubagentRunKind.Async, workspace, WorkspaceAccess.Write),
    );
    let secondWriteStarted = false;
    const secondWrite = supervisor
      .acquire(request(SubagentRunKind.Sync, child, WorkspaceAccess.Write))
      .then((lease) => {
        secondWriteStarted = true;
        return lease;
      });
    const sharedRead = await supervisor.acquire(
      request(SubagentRunKind.Direct, child, WorkspaceAccess.Read),
    );
    expect(secondWriteStarted).toBe(false);

    sharedRead.release(SubagentRunOutcome.Completed);
    firstWrite.release(SubagentRunOutcome.Completed);
    const secondWriteLease = await secondWrite;
    expect(secondWriteStarted).toBe(true);
    secondWriteLease.release(SubagentRunOutcome.Completed);
    await supervisor.shutdown();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("removes an aborted pending admission without starting it later", async () => {
    const supervisor = new SubagentRunSupervisor(
      "session",
      config({ maxConcurrentRuns: 1, maxPendingRuns: 1 }),
    );
    const active = await supervisor.acquire(
      request(SubagentRunKind.Sync, "/active", WorkspaceAccess.Read),
    );
    const controller = new AbortController();
    const pending = supervisor.acquire({
      ...request(SubagentRunKind.Async, "/pending", WorkspaceAccess.Read),
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });

    active.release(SubagentRunOutcome.Completed);
    const replacement = await supervisor.acquire(
      request(SubagentRunKind.Direct, "/replacement", WorkspaceAccess.Read),
    );
    replacement.release(SubagentRunOutcome.Completed);
    await supervisor.shutdown();
  });

  it("aborts a run at its wall-time budget", async () => {
    vi.useFakeTimers();
    try {
      const supervisor = new SubagentRunSupervisor("session", config({ maxRunMs: 20 }));
      const lease = await supervisor.acquire(
        request(SubagentRunKind.Sync, "/timed", WorkspaceAccess.Read),
      );
      expect(lease.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(20);
      expect(lease.signal.aborted).toBe(true);
      lease.release(SubagentRunOutcome.Interrupted);
      await supervisor.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces model, capacity, token, and cost budgets", async () => {
    const supervisor = new SubagentRunSupervisor(
      "session",
      config({ maxConcurrentRuns: 1, maxPendingRuns: 1, maxSessionTokens: 5, maxSessionCostUsd: 1 }),
    );
    await expect(
      supervisor.acquire({
        ...request(SubagentRunKind.Sync, "/one", WorkspaceAccess.Read),
        model: "other/model",
      }),
    ).rejects.toMatchObject({ reason: "model" });

    const active = await supervisor.acquire(request(SubagentRunKind.Sync, "/one", WorkspaceAccess.Read));
    const pending = supervisor
      .acquire(request(SubagentRunKind.Async, "/two", WorkspaceAccess.Read))
      .catch((error: unknown) => error);
    await expect(
      supervisor.acquire(request(SubagentRunKind.Direct, "/three", WorkspaceAccess.Read)),
    ).rejects.toMatchObject({ reason: "capacity" });

    active.updateUsage({ ...zeroUsage(), input: 5, cost: 1 });
    active.release(SubagentRunOutcome.Completed);
    expect(await pending).toMatchObject({ reason: "budget" });
    await expect(
      supervisor.acquire(request(SubagentRunKind.Sync, "/four", WorkspaceAccess.Read)),
    ).rejects.toBeInstanceOf(SubagentAdmissionError);
    await supervisor.shutdown();
  });
});
