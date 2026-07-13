import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeState = vi.hoisted(() => ({
  blocked: false,
  release: undefined as (() => void) | undefined,
  onBlockedStart: undefined as (() => void) | undefined,
  created: 0,
  disposed: new Map<number, number>(),
}));

vi.mock("../../../../src/telemetry/tooling", () => ({
  makeToolingTelemetryRuntime: vi.fn(() =>
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
        diagnostics: { span: (_n: string, _a: unknown, effect: unknown) => effect, annotate: () => Effect.void },
        provide: <A, E>(effect: Effect.Effect<A, E>) => effect,
        disposeEffect: Effect.sync(() => {
          runtimeState.disposed.set(id, (runtimeState.disposed.get(id) ?? 0) + 1);
        }),
      };
    }),
  ),
}));

import { SubagentSessionRuntime } from "../session-runtime";

describe("SubagentSessionRuntime telemetry lifecycle", () => {
  beforeEach(() => {
    runtimeState.blocked = false;
    runtimeState.release = undefined;
    runtimeState.onBlockedStart = undefined;
    runtimeState.created = 0;
    runtimeState.disposed.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeRuntime() {
    const pi = {
      appendEntry: () => {},
      registerTool: () => {},
      on: () => {},
      events: { emit: () => {}, on: () => {} },
    };
    return new SubagentSessionRuntime(pi as any, new Map());
  }

  it("disposes replaced telemetry exactly once and ignores repeated shutdown", async () => {
    const runtime = makeRuntime();

    await runtime.startSession();
    await runtime.startSession();
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

    const startup = runtime.startSession();
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

    const job = runtime.startJob({ name: "job", task: "task" } as any, { cwd: "/tmp" } as any);
    expect(job.details.status).toBe("inactive");
    expect(job.content[0]?.type === "text" ? job.content[0].text : "").toContain("Cannot start a subagent job");
  });
});
