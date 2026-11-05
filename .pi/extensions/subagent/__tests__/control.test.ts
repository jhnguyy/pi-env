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

function retainedChild(
  id: string,
  close: ChildTypes.NativeChildSession["close"] = vi.fn(async () => {}),
): ChildTypes.NativeChildSession {
  return {
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
      state: ChildTypes.NativeChildState.Idle,
    }),
    inspect: () => {
      throw new Error("unused inspection");
    },
    input: async () => {
      throw new Error("unused input");
    },
    cancel: async () => {},
    close,
  };
}

function deferredClose() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject, close: vi.fn(() => promise) };
}

describe("shared subagent run supervisor", () => {
  it.each(["global", "scoped"] as const)(
    "enforces the %s cap against replacement owners while displaced cleanup is blocked",
    async (mode) => {
      const { supervisor, cleanup } = fixture("replacement-cap", {
        maxRetainedJobs: mode === "global" ? 1 : 8,
      });
      const old = deferredClose();
      cleanup(old.resolve);
      const retention = mode === "scoped" ? { scopeId: "a", maxRetained: 1 } : undefined;
      const sibling = retainedChild("sibling");
      supervisor.retainChild(retainedChild("same", old.close), retention);
      supervisor.retainChild(sibling, retention);
      supervisor.pruneChildren();
      expect(old.close).toHaveBeenCalledTimes(1);

      const replacement = retainedChild("same");
      supervisor.retainChild(replacement, retention);
      supervisor.pruneChildren();
      expect(sibling.close).toHaveBeenCalledTimes(1);
      expect(replacement.close).not.toHaveBeenCalled();

      const newest = retainedChild("newest");
      supervisor.retainChild(newest, retention);
      supervisor.pruneChildren();
      expect(replacement.close).toHaveBeenCalledTimes(1);
      expect(newest.close).not.toHaveBeenCalled();
      expect(old.close).toHaveBeenCalledTimes(1);
      old.resolve();
      await supervisor.shutdown();
    },
  );

  it.each(["success", "rejection"] as const)(
    "waits for displaced eviction %s and active runs before settling shutdown",
    async (outcome) => {
      const supervisor = new Control.SubagentRunSupervisor(
        "displaced-shutdown",
        config({ maxRetainedJobs: 1 }),
      );
      const old = deferredClose();
      const failure = new Error("displaced cleanup failed");
      const lease = await supervisor.acquire(request("/active"));
      const cleanup = testCleanup();
      const verifyShutdown = async () => {
        if (outcome === "rejection")
          await expect(supervisor.shutdown()).rejects.toMatchObject({
            errors: [expect.objectContaining({ cause: failure })],
          });
        else await supervisor.shutdown();
      };
      cleanup(old.resolve, () => lease.release(), verifyShutdown);
      supervisor.retainChild(retainedChild("same", old.close));
      supervisor.retainChild(retainedChild("sibling"));
      supervisor.pruneChildren();
      const replacement = retainedChild("same");
      supervisor.retainChild(replacement);
      let settled = false;
      const shutdown = supervisor.shutdown();
      void shutdown.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      expect(replacement.close).toHaveBeenCalledTimes(1);
      expect(old.close).toHaveBeenCalledTimes(1);
      await expect(supervisor.acquire(request("/late"))).rejects.toMatchObject({
        reason: "closed",
      });
      expect(lease.signal.aborted).toBe(true);
      lease.release();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      if (outcome === "rejection") old.reject(failure);
      else old.resolve();
      await verifyShutdown();
      expect(settled).toBe(true);
      expect(old.close).toHaveBeenCalledTimes(1);
    },
  );

  it("continues closing current owners after a synchronous shutdown close failure", async () => {
    const supervisor = new Control.SubagentRunSupervisor("shutdown-throw", config());
    const failure = new Error("synchronous shutdown failure");
    const broken = retainedChild("broken", () => {
      throw failure;
    });
    const sibling = retainedChild("sibling");
    const verifyShutdown = () =>
      expect(supervisor.shutdown()).rejects.toMatchObject({
        errors: [failure],
      });
    testCleanup()(verifyShutdown);
    supervisor.retainChild(broken);
    supervisor.retainChild(sibling);
    await verifyShutdown();
    expect(sibling.close).toHaveBeenCalledTimes(1);
    expect(supervisor.children.size).toBe(0);
  });

  it.each(["synchronous", "asynchronous"] as const)(
    "bounds recorded %s eviction failures and retains the original cause",
    async (mode) => {
      const supervisor = new Control.SubagentRunSupervisor(
        "bounded-failures",
        config({ maxRetainedJobs: 1 }),
      );
      const failures = [new Error("first"), new Error("second"), new Error("third")];
      const closes = failures.map((failure) =>
        vi.fn(() => {
          if (mode === "synchronous") throw failure;
          return Promise.reject(failure);
        }),
      );
      const verifyShutdown = () =>
        expect(supervisor.shutdown()).rejects.toMatchObject({
          errors: [expect.objectContaining({ cause: failures[0] })],
          message: "Child shutdown failed. 2 additional eviction failure causes omitted.",
        });
      testCleanup()(verifyShutdown);
      for (const [index, close] of closes.entries())
        supervisor.retainChild(retainedChild(`broken-${index}`, close));
      supervisor.retainChild(retainedChild("retained"));
      supervisor.pruneChildren();
      await verifyShutdown();
      for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
    },
  );

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

  it("prunes within a scope without forgetting a replacement owner during old eviction", async () => {
    const { supervisor } = fixture("scoped-retention", { maxRetainedJobs: 8 });
    let finish!: () => void;
    const closing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const child = (id: string, close = async () => {}) => ({
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
        state: ChildTypes.NativeChildState.Idle,
      }),
      inspect: () => {
        throw new Error("unused inspection");
      },
      input: async () => {
        throw new Error("unused input");
      },
      cancel: async () => {},
      close,
    });
    let evictionStarted = false;
    const old = child("old", () => {
      evictionStarted = true;
      return closing;
    });
    const sibling = child("sibling");
    supervisor.retainChild(old, { scopeId: "a", maxRetained: 1 });
    supervisor.retainChild(sibling, { scopeId: "b", maxRetained: 1 });
    supervisor.retainChild(child("new"), { scopeId: "a", maxRetained: 1 });
    supervisor.pruneChildren();
    expect(evictionStarted).toBe(true);
    const replacement = child("old");
    supervisor.retainChild(replacement, { scopeId: "c", maxRetained: 1 });
    finish();
    await closing;
    await Promise.resolve();
    expect(supervisor.children.get("old")).toBe(replacement);
    expect(supervisor.children.get("sibling")).toBe(sibling);
    expect(supervisor.children.has("new")).toBe(true);
  });

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

  it("aggregates usage from sibling leases", async () => {
    const { supervisor, acquire } = fixture("usage");
    const first = await acquire({ ...request("/first"), runId: "batch:first" });
    const second = await acquire({ ...request("/second"), runId: "batch:second" });
    first.updateUsage({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0, cost: 2, turns: 2 });
    second.updateUsage({ input: 41, output: 10, cacheRead: 0, cacheWrite: 0, cost: 2, turns: 2 });
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(supervisor.usage("batch:")).toMatchObject({ input: 81, output: 20, cost: 4 });
  });

  it.each([
    { host: 100, target: undefined, expected: 100 },
    { host: 100, target: 40, expected: 40 },
    { host: 100, target: 200, expected: 100 },
    { host: 100, target: 1800000, expected: 100 },
    { host: undefined, target: 3600000, expected: 1800000 },
    { host: undefined, target: 40, expected: 40 },
    { host: undefined, target: undefined, expected: 1800000 },
  ])(
    "bounds deadlines by both host and target: $host / $target",
    async ({ host, target, expected }) => {
      const { acquire, cleanup } = fixture(
        "scoped-deadline",
        host === undefined ? {} : { maxRunMs: host },
      );
      const timer = vi.spyOn(globalThis, "setTimeout");
      cleanup(() => timer.mockRestore());
      const lease = await acquire({
        ...request("/timed"),
        scopeId: "target",
        ...(target === undefined ? {} : { limits: config({ maxRunMs: target }) }),
      });
      expect(timer).toHaveBeenLastCalledWith(expect.any(Function), expected);
      expect(lease.signal.aborted).toBe(false);
      const expire = timer.mock.calls.at(-1)![0];
      if (typeof expire !== "function") throw new Error("Expected a deadline callback");
      expire();
      expect(lease.signal.aborted).toBe(true);
      lease.release();
    },
  );

  it("keeps aborted scoped work admitted until settlement while allowing other scopes", async () => {
    const { supervisor, acquire } = fixture("scoped", { maxConcurrentRuns: 2 });
    const limits = config({ maxConcurrentRuns: 1, maxPendingRuns: 1 });
    const controller = new AbortController();
    const first = await acquire({
      ...request("/first"),
      scopeId: "a",
      limits,
      signal: controller.signal,
    });
    let started = false;
    const queued = acquire({ ...request("/queued"), scopeId: "a", limits }).then((lease) => {
      started = true;
      return lease;
    });
    await expect(
      supervisor.acquire({ ...request("/full"), scopeId: "a", limits }),
    ).rejects.toMatchObject({ reason: "capacity" });
    const other = await acquire({ ...request("/other"), scopeId: "b", limits });
    controller.abort();
    await Promise.resolve();
    expect(started).toBe(false);
    other.release();
    first.release();
    (await queued).release();
    expect(started).toBe(true);
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
