import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Fiber, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtToolRegistration } from "../../_shared/agent-tools";

const state = vi.hoisted(() => ({
  adapterCalls: [] as Array<{
    ctx: unknown;
    tools: unknown;
    artifactRoot: string;
    options: Record<string, unknown>;
  }>,
  executor: undefined as (() => Effect.Effect<Record<string, unknown>>) | undefined,
  telemetry: undefined as Record<string, unknown> | undefined,
  lifecycle: [] as string[],
}));

vi.mock("../../../../src/telemetry/tooling", () => ({
  makeToolingTelemetryRuntime: vi.fn(() =>
    Effect.sync(() => {
      const telemetry = {
        diagnostics: {
          span: (_name: string, _attributes: unknown, effect: unknown) => effect,
          annotate: () => Effect.void,
        },
        provide: <A, E>(effect: Effect.Effect<A, E>) => effect,
        disposeEffect: Effect.sync(() => state.lifecycle.push("telemetry-disposed")),
      };
      state.telemetry = telemetry;
      return telemetry;
    }),
  ),
}));

vi.mock("../dag-runtime", () => ({
  makeDagSubagentExecutorRegistry: vi.fn(
    (ctx: unknown, tools: unknown, artifactRoot: string, options: Record<string, unknown>) => {
      state.adapterCalls.push({ ctx, tools, artifactRoot, options });
      return {
        lookup: () => Effect.succeed(state.executor),
      };
    },
  ),
}));

import {
  DagExecutorKind,
  DagRuntimeJournalFailed,
  DagRuntimeNotAccepting,
  DagRuntimeRunAlreadyExists,
  DagSessionEntryType,
  DagSessionSeamFailed,
  DagTransitionType,
  validateDagDefinition,
} from "../../../../src/dag/index.js";
import {
  DagRuntimeServiceEvent,
  listenForDagRuntimeService,
  resetDagRuntimeServiceRegistryForTests,
  type DagRuntimeServiceRegistration,
} from "../../_shared/dag-runtime-service";
import { SubagentJobManager } from "../jobs";
import { SubagentSessionRuntime } from "../session-runtime";

const tempDirectories: string[] = [];

function makePi() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    appendEntry: () => {},
    registerTool: () => {},
    on: () => {},
    events: {
      emit(event: string, data: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(data);
      },
      on(event: string, handler: (data: unknown) => void) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
        return () => {
          const index = registered.indexOf(handler);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
  } as any;
}

function makeContext(cwd: string) {
  return {
    cwd,
    sessionManager: SessionManager.create(cwd, cwd),
    modelRegistry: {
      find: () => ({ provider: "test", id: "model", contextWindow: 32_000 }),
      getAvailable: () => [],
      getApiKeyForProvider: async () => "key",
    },
  } as any;
}

function graph(runId: string) {
  const result = validateDagDefinition({
    runId,
    concurrency: 1,
    nodes: [
      {
        id: "task",
        executor: { kind: DagExecutorKind.Transform, key: "test", payload: null },
        dependencies: [],
      },
    ],
  });
  if (result._tag !== "valid") throw new Error("invalid test graph");
  return result.graph;
}

beforeEach(() => {
  resetDagRuntimeServiceRegistryForTests();
  state.adapterCalls = [];
  state.executor = () => Effect.succeed({ artifact: "ref" });
  state.telemetry = undefined;
  state.lifecycle = [];
});

afterEach(() => {
  resetDagRuntimeServiceRegistryForTests();
  vi.clearAllMocks();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("session-owned DAG runtime composition", () => {
  it("reuses active authorities, persists one run in order, and reconstructs an immutable result", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-dag-session-"));
    tempDirectories.push(cwd);
    const pi = makePi();
    const ctx = makeContext(cwd);
    const tools = new Map<string, ExtToolRegistration>();
    const runtime = new SubagentSessionRuntime(pi, tools);

    await runtime.startSession(ctx);
    const registrations: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(pi, (registration) => registrations.push(registration));
    expect(registrations).toHaveLength(1);

    const adapter = state.adapterCalls[0];
    expect(adapter.ctx).toBe(ctx);
    expect(adapter.tools).toBe(tools);
    expect(adapter.options.supervisor).toBeDefined();
    expect(adapter.options.telemetryRuntime).toBe(state.telemetry);
    expect(adapter.artifactRoot).toBe(
      path.join(
        ctx.sessionManager.getSessionDir(),
        "dag-artifacts",
        ctx.sessionManager.getSessionId(),
      ),
    );
    expect(statSync(adapter.artifactRoot).isDirectory()).toBe(true);

    const registration = registrations[0];
    const handle = await Effect.runPromise(registration.service.submit(graph("composed-run")));
    const completed = await Effect.runPromise(handle.await);
    expect(completed.state.nodes[0]).toMatchObject({ status: "succeeded" });
    expect(registration.service.usage?.("composed-run")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    });

    const entries = ctx.sessionManager
      .getBranch()
      .filter((entry: any) => entry.type === "custom" && entry.customType === DagSessionEntryType)
      .map((entry: any) => entry.data.event);
    expect(entries.map((event: any) => event._tag)).toEqual([
      "graph",
      "transition",
      "transition",
      "final",
    ]);
    expect(entries.slice(1, 3).map((event: any) => event.transition.type)).toEqual([
      DagTransitionType.Start,
      DagTransitionType.Complete,
    ]);

    const reconstruction = await Effect.runPromise(
      registration.service.reconstruct("composed-run"),
    );
    expect(reconstruction.recoveredFromProcessLoss).toBe(false);
    expect(Object.isFrozen(reconstruction)).toBe(true);
    expect(Object.isFrozen(reconstruction.state)).toBe(true);
    expect(Object.isFrozen(reconstruction.transitions)).toBe(true);

    const duplicate = await Effect.runPromise(
      Effect.exit(registration.service.submit(graph("composed-run"))),
    );
    expect(duplicate._tag).toBe("Failure");
    if (duplicate._tag === "Failure") {
      const failure = Cause.findErrorOption(duplicate.cause);
      expect(Option.isSome(failure) && failure.value instanceof DagRuntimeRunAlreadyExists).toBe(
        true,
      );
    }

    await runtime.shutdownSession();
    await runtime.startSession(ctx);
    const afterRestart = registrations.at(-1)!;
    const persistedDuplicate = await Effect.runPromise(
      Effect.exit(afterRestart.service.submit(graph("composed-run"))),
    );
    expect(persistedDuplicate._tag).toBe("Failure");
    if (persistedDuplicate._tag === "Failure") {
      const failure = Cause.findErrorOption(persistedDuplicate.cause);
      expect(Option.isSome(failure) && failure.value instanceof DagRuntimeRunAlreadyExists).toBe(
        true,
      );
    }
    await runtime.shutdownSession();
  });

  it("preserves the typed session cause when the graph append fails before execution", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-dag-append-failure-"));
    tempDirectories.push(cwd);
    const pi = makePi();
    const runtime = new SubagentSessionRuntime(pi, new Map());
    const ctx = makeContext(cwd);
    let registration: DagRuntimeServiceRegistration | undefined;
    listenForDagRuntimeService(pi, (active) => {
      registration = active;
    });
    const seamCause = new Error("session append unavailable");
    state.executor = () =>
      Effect.sync(() => state.lifecycle.push("executor-invoked")).pipe(
        Effect.as({ artifact: "unreachable" }),
      );

    await runtime.startSession(ctx);
    const appendSpy = vi.spyOn(ctx.sessionManager, "appendCustomEntry").mockImplementation(() => {
      throw seamCause;
    });
    const handle = await Effect.runPromise(
      registration!.service.submit(graph("append-failure-run")),
    );
    const awaitExit = await Effect.runPromise(Effect.exit(handle.await));
    const cancelExit = await Effect.runPromise(Effect.exit(handle.cancel));

    for (const exit of [awaitExit, cancelExit]) {
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") continue;
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure) && failure.value instanceof DagRuntimeJournalFailed).toBe(true);
      if (Option.isSome(failure) && failure.value instanceof DagRuntimeJournalFailed) {
        expect(failure.value.cause).toBeInstanceOf(DagSessionSeamFailed);
        expect((failure.value.cause as DagSessionSeamFailed).cause).toBe(seamCause);
      }
    }
    expect(state.lifecycle).not.toContain("executor-invoked");
    appendSpy.mockRestore();
    const retry = await Effect.runPromise(
      registration!.service.submit(graph("append-failure-run")),
    );
    const retried = await Effect.runPromise(retry.await);
    expect(retried.state.nodes[0]).toMatchObject({ status: "succeeded" });
    await runtime.shutdownSession();
  });

  it("cancels active work and unregisters before shared telemetry disposal", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "pi-dag-shutdown-"));
    tempDirectories.push(cwd);
    const pi = makePi();
    const runtime = new SubagentSessionRuntime(pi, new Map());
    const ctx = makeContext(cwd);
    let registration: DagRuntimeServiceRegistration | undefined;
    listenForDagRuntimeService(
      pi,
      (active) => {
        registration = active;
      },
      () => state.lifecycle.push("unregistered"),
    );
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    state.executor = () =>
      Effect.sync(markStarted).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => state.lifecycle.push("executor-interrupted"))),
      );

    await runtime.startSession(ctx);
    const handle = await Effect.runPromise(registration!.service.submit(graph("shutdown-run")));
    await started;
    const interruptedObserver = Effect.runFork(handle.await);
    await Effect.runPromise(Fiber.interrupt(interruptedObserver));
    pi.events.on(DagRuntimeServiceEvent.Unregister, () => {
      throw new Error("consumer unregister failure");
    });
    const jobShutdownFailure = new Error("job shutdown failure");
    vi.spyOn(SubagentJobManager.prototype, "shutdown").mockRejectedValueOnce(jobShutdownFailure);

    const shutdown = runtime.shutdownSession();
    const admissionExit = await Effect.runPromise(
      Effect.exit(registration!.service.submit(graph("late-run"))),
    );
    expect(admissionExit._tag).toBe("Failure");
    if (admissionExit._tag === "Failure") {
      const failure = Cause.findErrorOption(admissionExit.cause);
      expect(Option.isSome(failure) && failure.value instanceof DagRuntimeNotAccepting).toBe(true);
    }
    await expect(shutdown).rejects.toBe(jobShutdownFailure);
    expect(runtime.state).toBe("inactive");
    const cancelled = await Effect.runPromise(handle.await);
    expect(cancelled.state.nodes[0]).toMatchObject({ status: "cancelled" });
    expect(state.lifecycle).toEqual(["executor-interrupted", "unregistered", "telemetry-disposed"]);

    const late: DagRuntimeServiceRegistration[] = [];
    listenForDagRuntimeService(pi, (active) => late.push(active));
    expect(late).toEqual([]);
  });
});
