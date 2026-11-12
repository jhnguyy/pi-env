import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_CONFIG, type SubagentRuntimeConfig } from "../config";
import * as Control from "../control";
import * as ChildTypes from "../child-types";
import { testCleanup } from "./cleanup";

function config(overrides: Partial<SubagentRuntimeConfig> = {}): SubagentRuntimeConfig {
  return { ...DEFAULT_SUBAGENT_CONFIG, maxConcurrentRuns: 2, maxPendingRuns: 2, ...overrides };
}
function request(
  cwd: string,
  workspaceAccess: (typeof Control.WorkspaceAccess)[keyof typeof Control.WorkspaceAccess] = Control
    .WorkspaceAccess.Read,
) {
  return { cwd, workspaceAccess };
}
function fixture(
  id: string,
  overrides: Partial<SubagentRuntimeConfig> = {},
  cleanup = testCleanup(),
) {
  const supervisor = new Control.SubagentRunSupervisor(id, config(overrides));
  const leases = new Set<Awaited<ReturnType<typeof supervisor.acquire>>>();
  let closing = false;
  cleanup(
    () => {
      closing = true;
      for (const lease of leases) lease.release();
    },
    () => supervisor.shutdown(),
  );
  return {
    supervisor,
    cleanup,
    acquire: (input: Parameters<typeof supervisor.acquire>[0]) => {
      const pending = supervisor.acquire(input).then((lease) => {
        if (closing) lease.release();
        else leases.add(lease);
        return lease;
      });
      // Teardown may reject a queued acquisition after its scenario already failed.
      void pending.catch(() => {});
      return pending;
    },
  };
}

describe("shared subagent run supervisor", () => {
  it.each([true, false])(
    "reports rejected eviction cleanup at shutdown even when closed=%s",
    async (closedAfterFailure) => {
      // Inject failure at the existing owner close port: SDK hooks do not reliably reject dispose.
      const supervisor = new Control.SubagentRunSupervisor(
        "eviction-failure",
        config({ maxRetainedJobs: 1 }),
      );
      const failure = new Error("native disposal failed");
      const verifyShutdown = () =>
        expect(supervisor.shutdown()).rejects.toMatchObject({
          errors: expect.arrayContaining([expect.objectContaining({ cause: failure })]),
        });
      testCleanup()(verifyShutdown);
      let closed = false;
      const child = (id: string, broken: boolean) => ({
        id,
        runId: id,
        summary: () => ({
          id,
          runId: id,
          name: id,
          task: "task",
          cwd: "/fixture",
          sessionFile: undefined,
          model: undefined,
          state:
            broken && closed
              ? ChildTypes.NativeChildState.Closed
              : ChildTypes.NativeChildState.Idle,
        }),
        checkpointUsage: () => {},
        inspect: () => {
          throw new Error("unused inspection");
        },
        input: async () => {
          throw new Error("unused input");
        },
        cancel: async () => {},
        close: async () => {
          if (broken) {
            closed = closedAfterFailure;
            throw failure;
          }
        },
      });
      supervisor.retainChild(child("broken", true));
      supervisor.retainChild(child("retained", false));
      supervisor.pruneChildren();
      await Promise.resolve();
      await Promise.resolve();
      await verifyShutdown();
    },
  );

  it("coalesces parent disposal until held work settles without reopening admission", async () => {
    const cleanup = testCleanup();
    const supervisor = Control.getOrCreateSubagentRunSupervisor("coalesced-dispose", config());
    cleanup(() => Control.disposeSubagentRunSupervisor("coalesced-dispose"));
    const lease = await supervisor.acquire(request("/coalesced"));
    cleanup(() => lease.release());
    let secondFinished = false;
    const first = Control.disposeSubagentRunSupervisor("coalesced-dispose");
    const second = Control.disposeSubagentRunSupervisor("coalesced-dispose").then(() => {
      secondFinished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondFinished).toBe(false);
    expect(Control.getOrCreateSubagentRunSupervisor("coalesced-dispose", config())).toBe(
      supervisor,
    );
    await expect(supervisor.acquire(request("/late"))).rejects.toMatchObject({ reason: "closed" });
    lease.release();
    await Promise.all([first, second]);
    expect(Control.getSubagentRunSupervisor("coalesced-dispose")).toBeUndefined();
  });

  it.each(["AbortSignal", "Effect"] as const)(
    "removes pending %s admission before the active lease releases",
    async (mode) => {
      const { supervisor, cleanup, acquire } = fixture(mode, {
        maxConcurrentRuns: 1,
        maxPendingRuns: 1,
      });
      const active = await acquire(request("/active"));
      const controller = new AbortController();
      cleanup(() => controller.abort());
      const acquireAdmission = supervisor.acquire.bind(supervisor);
      let queued!: () => void;
      const enteredAdmission = new Promise<void>((resolve) => {
        queued = resolve;
      });
      const spy = vi.spyOn(supervisor, "acquire").mockImplementation((input) => {
        const pending = acquireAdmission(input);
        if (input.cwd === "/pending") queued();
        return pending;
      });
      cleanup(() => spy.mockRestore());
      const pending =
        mode === "Effect"
          ? Effect.runPromiseExit(supervisor.acquireEffect(request("/pending")), {
              signal: controller.signal,
            })
          : supervisor.acquire({ ...request("/pending"), signal: controller.signal });
      await enteredAdmission;
      await expect(supervisor.acquire(request("/full"))).rejects.toMatchObject({
        reason: "capacity",
      });
      controller.abort();
      if (mode === "Effect") {
        const exit = await pending;
        if (!Exit.isExit(exit)) throw new Error("Expected an Effect exit");
        expect(Exit.hasInterrupts(exit)).toBe(true);
      } else await expect(pending).rejects.toMatchObject({ reason: "aborted" });
      const replacement = acquire(request("/replacement"));
      // If cancellation left the old slot behind, replacement rejects instead of occupying it.
      await expect(supervisor.acquire(request("/still-full"))).rejects.toMatchObject({
        reason: "capacity",
      });
      active.release();
      (await replacement).release();
    },
  );

  it("admits a read beside an active writer and serializes canonical-workspace writers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-supervisor-workspace-"));
    const cleanup = testCleanup();
    cleanup(() => rmSync(workspace, { recursive: true, force: true }));
    const child = join(workspace, "packages", "child");
    mkdirSync(join(workspace, ".git"));
    mkdirSync(child, { recursive: true });
    const { acquire } = fixture("workspace", {}, cleanup);
    const firstWrite = await acquire(request(workspace, Control.WorkspaceAccess.Write));
    let secondWriteStarted = false;
    const secondWrite = acquire(request(child, Control.WorkspaceAccess.Write)).then((lease) => {
      secondWriteStarted = true;
      return lease;
    });
    const sharedRead = await acquire(request(child));
    expect(secondWriteStarted).toBe(false);
    sharedRead.release();
    firstWrite.release();
    const secondWriteLease = await secondWrite;
    expect(secondWriteStarted).toBe(true);
    secondWriteLease.release();
  });

  it("aborts a run at its wall-time limit", async () => {
    const { acquire } = fixture("deadline", { maxRunMs: 20 });
    const lease = await acquire(request("/timed"));
    expect(lease.signal.aborted).toBe(false);
    await new Promise<void>((resolve) =>
      lease.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(lease.signal.aborted).toBe(true);
  });
});
