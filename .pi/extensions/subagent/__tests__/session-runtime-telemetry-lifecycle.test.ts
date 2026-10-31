import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serviceClientFixture } from "./service-client.fixture";

// The registered workflow owns transport integration; this port controls startup races.
const transport = { close: vi.fn(async () => {}) };
import { noopToolingDiagnostics } from "../../../../src/telemetry/tooling";
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
    transport.close.mockClear();
    runtimeState.blocked = false;
    runtimeState.release = undefined;
    runtimeState.onBlockedStart = undefined;
    runtimeState.created = 0;
    runtimeState.disposed.clear();
  });

  const runtimes: SubagentSessionRuntime[] = [];
  const directories: string[] = [];
  afterEach(async () => {
    runtimeState.release?.();
    try {
      await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdownSession()));
    } finally {
      for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeRuntime(factory = telemetryRuntimeFactory) {
    const pi = {
      appendEntry: () => {},
      registerTool: () => {},
      on: () => {},
      events: { emit: () => {}, on: () => {} },
    };
    const runtime = new SubagentSessionRuntime(pi as any, {
      telemetryRuntimeFactory: factory,
      serviceConnectionFactory: async () => serviceClientFixture(transport),
    });
    runtimes.push(runtime);
    return runtime;
  }

  function sessionContext() {
    const cwd = mkdtempSync(join(tmpdir(), "pi-telemetry-lifecycle-"));
    directories.push(cwd);
    return {
      cwd,
      sessionManager: SessionManager.create(cwd, cwd),
    } as any;
  }

  it("closes the acquired client when telemetry startup fails", async () => {
    const runtime = makeRuntime(() => Effect.die(new Error("telemetry unavailable")));
    await expect(runtime.startSession(sessionContext())).rejects.toThrow("telemetry unavailable");
    expect(transport.close).toHaveBeenCalledTimes(1);
    await runtime.shutdownSession();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("disposes replaced telemetry exactly once and ignores repeated shutdown", async () => {
    const runtime = makeRuntime();
    const ctx = sessionContext();

    await runtime.startSession(ctx);
    await runtime.startSession(ctx);
    await runtime.shutdownSession();
    await runtime.shutdownSession();

    expect(transport.close).toHaveBeenCalledTimes(2);
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
    const [activated] = await Promise.all([startup, shutdown]);
    expect(activated).toBe(false);
    expect(transport.close).toHaveBeenCalledTimes(1);

    expect(runtimeState.created).toBe(1);
    expect([...runtimeState.disposed.values()]).toEqual([1]);
    expect(runtime.state).toBe("inactive");

    await expect(runtime.startJob({ name: "job", task: "task" }, { cwd: "/tmp" } as any))
      .rejects.toThrow("Parent subagent session is not active.");
  });
});
