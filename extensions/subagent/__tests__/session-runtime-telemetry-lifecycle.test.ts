import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSubagentRunSupervisor } from "../control";
import { SubagentJobManager } from "../jobs";
import { noopToolingDiagnostics } from "../../../src/telemetry/tooling";
import { testCleanup } from "./cleanup";
import {
  SubagentSessionRuntime,
  type SubagentSessionRuntimeDependencies,
} from "../session-runtime";

const runtimeState = {
  blocked: false,
  release: undefined as (() => void) | undefined,
  onBlockedStart: undefined as (() => void) | undefined,
  created: 0,
  disposed: new Map<number, number>(),
};

const telemetryRuntimeFactory: NonNullable<
  SubagentSessionRuntimeDependencies["telemetryRuntimeFactory"]
> = () =>
  Effect.promise(async () => {
    const id = ++runtimeState.created;
    runtimeState.disposed.set(id, 0);

    if (runtimeState.blocked) {
      runtimeState.onBlockedStart?.();
      await new Promise<void>((resolve) => {
        runtimeState.release = resolve;
      });
    }

    return {
      diagnostics: noopToolingDiagnostics,
      provide: <A, E>(effect: Effect.Effect<A, E>) => effect,
      disposeEffect: Effect.sync(() => {
        runtimeState.disposed.set(id, (runtimeState.disposed.get(id) ?? 0) + 1);
      }),
    };
  });

describe("SubagentSessionRuntime telemetry lifecycle", () => {
  beforeEach(() => {
    runtimeState.blocked = false;
    runtimeState.release = undefined;
    runtimeState.onBlockedStart = undefined;
    runtimeState.created = 0;
    runtimeState.disposed.clear();
  });

  function makeRuntime() {
    const pi = {
      appendEntry: () => {},
      registerTool: () => {},
      on: () => {},
      events: { emit: () => {}, on: () => {} },
    };
    const runtime = new SubagentSessionRuntime(pi as any, { telemetryRuntimeFactory });
    testCleanup()(
      () => {
        runtimeState.blocked = false;
        runtimeState.release?.();
      },
      () => runtime.shutdownSession(),
    );
    return runtime;
  }

  function sessionContext() {
    return {
      cwd: "/tmp",
      sessionManager: SessionManager.inMemory("/tmp"),
    } as any;
  }

  it.each([false, true])(
    "waits for retained owners before disposing telemetry, including job shutdown failure=%s",
    async (failJobs) => {
      const runtime = makeRuntime();
      const ctx = sessionContext();
      await runtime.startSession(ctx);
      let markClosing!: () => void;
      const closing = new Promise<void>((resolve) => {
        markClosing = resolve;
      });
      let release!: () => void;
      const settled = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closed = false;
      getSubagentRunSupervisor(ctx.sessionManager.getSessionId())!.retainChild({
        id: "retained",
        close: async () => {
          markClosing();
          await settled;
          closed = true;
        },
      } as any);
      const failure = new Error("job shutdown failed");
      const shutdownSpy = failJobs
        ? vi.spyOn(SubagentJobManager.prototype, "shutdown").mockRejectedValueOnce(failure)
        : undefined;
      testCleanup()(() => {
        release();
        shutdownSpy?.mockRestore();
      });

      const shutdown = runtime.shutdownSession();
      // Attach the rejection observer before allowing cleanup to finish.
      const outcome = shutdown.then(
        () => undefined,
        (cause) => cause,
      );
      await closing;
      expect(runtime.state).toBe("shutting-down");
      expect([...runtimeState.disposed.values()]).toEqual([0]);
      expect(runtime.startJob({ name: "late", task: "late" }, ctx).details.status).toBe(
        "shutting-down",
      );
      expect(
        (await runtime.execute("late", { name: "late", task: "late" }, undefined, undefined, ctx))
          .details.isError,
      ).toBe(true);
      expect(() => runtime.inputChild("retained", "late", "prompt")).toThrow(/not active/);
      release();
      expect(await outcome).toBe(failJobs ? failure : undefined);
      expect(closed).toBe(true);
      expect(getSubagentRunSupervisor(ctx.sessionManager.getSessionId())).toBeUndefined();
      expect([...runtimeState.disposed.values()]).toEqual([1]);
      expect(runtime.state).toBe("inactive");
    },
  );

  it("forwards child changes across session replacement and detaches old supervisors", async () => {
    const runtime = makeRuntime();
    const changed = vi.fn();
    const unsubscribe = runtime.subscribeChildren(changed);
    testCleanup()(unsubscribe);
    const first = sessionContext();
    await runtime.startSession(first);
    const previous = getSubagentRunSupervisor(first.sessionManager.getSessionId())!;
    changed.mockClear();
    previous.notifyChildrenChanged();
    expect(changed).toHaveBeenCalledOnce();
    const second = sessionContext();
    await runtime.startSession(second);
    changed.mockClear();
    previous.notifyChildrenChanged();
    expect(changed).not.toHaveBeenCalled();
    getSubagentRunSupervisor(second.sessionManager.getSessionId())!.notifyChildrenChanged();
    expect(changed).toHaveBeenCalledOnce();
    unsubscribe();
    getSubagentRunSupervisor(second.sessionManager.getSessionId())!.notifyChildrenChanged();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("disposes replaced telemetry exactly once and ignores repeated shutdown", async () => {
    const runtime = makeRuntime();
    const ctx = sessionContext();

    await runtime.startSession(ctx);
    await runtime.startSession(ctx);
    await runtime.shutdownSession();
    await runtime.shutdownSession();

    expect(runtimeState.created).toBe(2);
    expect([...runtimeState.disposed.values()]).toEqual([1, 1]);
    expect(runtime.state).toBe("inactive");
  });

  it("waits for blocked telemetry startup and disposes stale runtime once when shutdown supersedes it", async () => {
    const runtime = makeRuntime();
    runtimeState.blocked = true;
    let startupBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      startupBlocked = resolve;
    });
    runtimeState.onBlockedStart = startupBlocked;

    const startup = runtime.startSession(sessionContext());
    await blocked;
    let shutdownSettled = false;
    const shutdown = runtime.shutdownSession().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    runtimeState.blocked = false;
    runtimeState.release?.();
    await Promise.all([startup, shutdown]);

    expect(runtimeState.created).toBe(1);
    expect([...runtimeState.disposed.values()]).toEqual([1]);
    expect(runtime.state).toBe("inactive");

    const job = runtime.startJob({ name: "job", task: "task" }, { cwd: "/tmp" } as any);
    expect(job.details.status).toBe("inactive");
    expect(job.content[0]?.type === "text" ? job.content[0].text : "").toContain(
      "Cannot start a subagent job",
    );
  });
});
