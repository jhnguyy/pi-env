import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Scope } from "effect";
import { describe, expect } from "vitest";
import {
  DagBlockedReason,
  DagCompletionGuardKind,
  DagDependencyMode,
  DagExecutorDefected,
  DagExecutorFailed,
  DagExecutorKind,
  DagExecutorMissing,
  DagExecutorRegistryLayer,
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagRunOutcomeResultTag,
  DagRuntimeGraphStateMismatch,
  DagRuntimeLive,
  DagRuntimeNonFreshInitialState,
  DagTransitionType,
  createDagRunState,
  reduceDagRunState,
  submitDagRun,
  type DagEffectExecutor,
  type DagExecutorRegistryService,
  type DagFailedNodePayload,
  type DagExecutorRequest,
  type DagNode,
} from "../index.js";
import { graph } from "./shared.js";

const testExecutor = (key: string, payload?: unknown) =>
  ({ kind: DagExecutorKind.Transform, key, payload }) as const;

function runtimeNode(
  id: string,
  key = id,
  dependencies: DagNode["dependencies"] = [],
  completionGuard?: DagNode["completionGuard"],
): DagNode {
  return {
    id,
    executor: testExecutor(key),
    dependencies,
    ...(completionGuard ? { completionGuard } : {}),
  };
}

function runtimeLayer(registry: DagExecutorRegistryService) {
  return Layer.mergeAll(DagRuntimeLive, DagExecutorRegistryLayer(registry));
}

function registryFromMap(executors: Record<string, DagEffectExecutor>) {
  const lookups: Array<readonly [string, string]> = [];
  const service: DagExecutorRegistryService = {
    lookup: (kind, key) =>
      Effect.sync(() => {
        lookups.push([kind, key]);
        return executors[key];
      }),
  };
  return { service, lookups };
}

function dependency(
  nodeId: string,
  mode: typeof DagDependencyMode.Required | typeof DagDependencyMode.Settled,
) {
  return { nodeId, mode } as const;
}

describe("DAG runtime", () => {
  it.effect("invokes the injected executor resolved by kind and key", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task", "executor-key")]);
      const requestRef = yield* Ref.make<DagExecutorRequest | undefined>(undefined);
      const { service, lookups } = registryFromMap({
        "executor-key": (request) =>
          Ref.set(requestRef, request).pipe(Effect.as({ artifact: "ok" })),
      });

      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      const request = yield* Ref.get(requestRef);

      expect(lookups).toEqual([[DagExecutorKind.Transform, "executor-key"]]);
      expect(request).toMatchObject({
        runId: "run-test",
        attemptId: "run-test:task:1",
        attemptOrdinal: 1,
        node: { id: "task", executor: { kind: DagExecutorKind.Transform, key: "executor-key" } },
      });
      expect(request?.graphState.nodes).toEqual([
        { nodeId: "task", status: DagNodeStatus.Running },
      ]);
      expect(snapshot.state.nodes).toEqual([
        { nodeId: "task", status: DagNodeStatus.Succeeded, outputs: { artifact: "ok" } },
      ]);
    }),
  );

  it.effect("starts exactly up to graph concurrency and refills capacity after completion", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("a"), runtimeNode("b"), runtimeNode("c")], 2);
      const started = yield* Queue.unbounded<string>();
      const requests = yield* Queue.unbounded<DagExecutorRequest>();
      const releases = new Map<string, Deferred.Deferred<void>>();
      for (const id of ["a", "b", "c"] as const) releases.set(id, yield* Deferred.make<void>());
      const { service } = registryFromMap({
        a: (request) =>
          Queue.offer(requests, request).pipe(
            Effect.andThen(Queue.offer(started, "a")),
            Effect.andThen(Deferred.await(releases.get("a")!)),
            Effect.as({}),
          ),
        b: (request) =>
          Queue.offer(requests, request).pipe(
            Effect.andThen(Queue.offer(started, "b")),
            Effect.andThen(Deferred.await(releases.get("b")!)),
            Effect.as({}),
          ),
        c: (request) =>
          Queue.offer(requests, request).pipe(
            Effect.andThen(Queue.offer(started, "c")),
            Effect.andThen(Deferred.await(releases.get("c")!)),
            Effect.as({}),
          ),
      });

      const scope = yield* Scope.make();
      const handle = yield* submitDagRun(dag).pipe(
        Effect.provide(runtimeLayer(service)),
        Scope.provide(scope),
      );
      const firstStarted = [yield* Queue.take(started), yield* Queue.take(started)];
      expect(firstStarted).toEqual(["a", "b"]);
      const firstRequests = [yield* Queue.take(requests), yield* Queue.take(requests)];
      expect(firstRequests.map((request) => request.node.id)).toEqual(["a", "b"]);
      for (const request of firstRequests) {
        expect(request.graphState.nodes).toEqual([
          { nodeId: "a", status: DagNodeStatus.Running },
          { nodeId: "b", status: DagNodeStatus.Running },
          { nodeId: "c", status: DagNodeStatus.Queued },
        ]);
      }
      expect((yield* handle.snapshot).state.nodes.map((node) => node.status)).toEqual([
        DagNodeStatus.Running,
        DagNodeStatus.Running,
        DagNodeStatus.Queued,
      ]);
      yield* Deferred.succeed(releases.get("a")!, undefined);
      expect(yield* Queue.take(started)).toEqual("c");
      expect((yield* handle.snapshot).state.nodes.map((node) => node.status)).toEqual([
        DagNodeStatus.Succeeded,
        DagNodeStatus.Running,
        DagNodeStatus.Running,
      ]);
      yield* Deferred.succeed(releases.get("b")!, undefined);
      yield* Deferred.succeed(releases.get("c")!, undefined);
      const snapshot = yield* handle.await;
      yield* Scope.close(scope, Exit.void);
      expect(snapshot.outcome).toEqual({
        _tag: DagRunOutcomeResultTag.Terminal,
        outcome: DagRunOutcome.Succeeded,
      });
    }),
  );

  it.effect("preserves start before complete transition ordering", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const { service } = registryFromMap({ task: () => Effect.succeed({}) });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.transitions.map((transition) => transition.type)).toEqual([
        DagTransitionType.Start,
        DagTransitionType.Complete,
      ]);
    }),
  );

  it.effect("surfaces typed executor failure as expected failed node outcome", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const { service } = registryFromMap({
        task: () => Effect.fail({ code: "EXPECTED" } as const),
      });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.state.nodes[0]).toMatchObject({
        nodeId: "task",
        status: DagNodeStatus.Failed,
        failure: new DagExecutorFailed({
          message: "DAG executor failed.",
          error: { code: "EXPECTED" },
        }),
      });
      expect(snapshot.attempts[0]).toEqual({
        nodeId: "task",
        attemptId: "run-test:task:1",
        ordinal: 1,
        statuses: [DagNodeStatus.Running, DagNodeResultTag.Failed],
      });
      expect(snapshot.outcome).toEqual({
        _tag: DagRunOutcomeResultTag.Terminal,
        outcome: DagRunOutcome.Failed,
      });
    }),
  );

  it.effect("continues an independent branch after a required dependency failure", () =>
    Effect.gen(function* () {
      const dag = graph([
        runtimeNode("root"),
        runtimeNode("blocked", "blocked", [dependency("root", DagDependencyMode.Required)]),
        runtimeNode("independent"),
      ]);
      const { service } = registryFromMap({
        root: () => Effect.fail("boom"),
        blocked: () => Effect.succeed({ unreachable: true }),
        independent: () => Effect.succeed({ ok: true }),
      });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.state.nodes).toEqual([
        expect.objectContaining({ nodeId: "root", status: DagNodeStatus.Failed }),
        {
          nodeId: "blocked",
          status: DagNodeStatus.Blocked,
          reason: DagBlockedReason.RequiredDependency,
          blockedBy: ["root"],
        },
        { nodeId: "independent", status: DagNodeStatus.Succeeded, outputs: { ok: true } },
      ]);
    }),
  );

  it.effect("blocks required descendants after ancestor failure", () =>
    Effect.gen(function* () {
      const dag = graph([
        runtimeNode("root"),
        runtimeNode("child", "child", [dependency("root", DagDependencyMode.Required)]),
        runtimeNode("grandchild", "grandchild", [dependency("child", DagDependencyMode.Required)]),
      ]);
      const { service } = registryFromMap({
        root: () => Effect.fail("boom"),
        child: () => Effect.succeed({}),
        grandchild: () => Effect.succeed({}),
      });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.state.nodes[1]).toEqual({
        nodeId: "child",
        status: DagNodeStatus.Blocked,
        reason: DagBlockedReason.RequiredDependency,
        blockedBy: ["root"],
      });
      expect(snapshot.state.nodes[2]).toEqual({
        nodeId: "grandchild",
        status: DagNodeStatus.Blocked,
        reason: DagBlockedReason.RequiredDependency,
        blockedBy: ["child"],
      });
    }),
  );

  it.effect("continues from a settled dependency after failure", () =>
    Effect.gen(function* () {
      const dag = graph([
        runtimeNode("producer"),
        runtimeNode("observer", "observer", [dependency("producer", DagDependencyMode.Settled)]),
      ]);
      const { service } = registryFromMap({
        producer: () => Effect.fail("boom"),
        observer: () => Effect.succeed({ observed: true }),
      });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.state.nodes).toEqual([
        expect.objectContaining({ nodeId: "producer", status: DagNodeStatus.Failed }),
        { nodeId: "observer", status: DagNodeStatus.Succeeded, outputs: { observed: true } },
      ]);
    }),
  );

  it.effect("fails the node when an executor is missing", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task", "missing-key")]);
      const { service, lookups } = registryFromMap({});
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(lookups).toEqual([[DagExecutorKind.Transform, "missing-key"]]);
      expect(snapshot.state.nodes).toEqual([
        {
          nodeId: "task",
          status: DagNodeStatus.Failed,
          failure: new DagExecutorMissing({
            message: "DAG executor was not found.",
            kind: DagExecutorKind.Transform,
            key: "missing-key",
          }),
        },
      ]);
    }),
  );

  it.effect("distinguishes executor defects from expected failures", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const { service } = registryFromMap({ task: () => Effect.die("defect") });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.state.nodes).toEqual([
        {
          nodeId: "task",
          status: DagNodeStatus.Failed,
          failure: new DagExecutorDefected({ message: "DAG executor defected.", defect: "defect" }),
        },
      ]);
      expect(snapshot.state.nodes[0]).not.toMatchObject({ failure: expect.any(DagExecutorFailed) });
    }),
  );

  it.effect("fails a node exactly once when registry lookup defects", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const service: DagExecutorRegistryService = { lookup: () => Effect.die("lookup-defect") };
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.state.nodes).toEqual([
        {
          nodeId: "task",
          status: DagNodeStatus.Failed,
          failure: new DagExecutorDefected({
            message: "DAG executor defected.",
            defect: "lookup-defect",
          }),
        },
      ]);
      expect(
        snapshot.transitions.filter((transition) => transition.type === DagTransitionType.Complete),
      ).toHaveLength(1);
    }),
  );

  it.effect(
    "cancels a never-ending registry lookup through the legal queued-scope-cancel limitation",
    () =>
      Effect.gen(function* () {
        const dag = graph([runtimeNode("task")]);
        const lookupStarted = yield* Deferred.make<void>();
        const finalizers = yield* Ref.make(0);
        const service: DagExecutorRegistryService = {
          lookup: () =>
            Effect.scoped(
              Effect.acquireRelease(Deferred.succeed(lookupStarted, undefined), () =>
                Ref.update(finalizers, (count) => count + 1),
              ).pipe(Effect.andThen(Effect.never)),
            ),
        };
        const scope = yield* Scope.make();
        const handle = yield* submitDagRun(dag).pipe(
          Effect.provide(runtimeLayer(service)),
          Scope.provide(scope),
        );
        yield* Deferred.await(lookupStarted);
        const snapshot = yield* handle.cancel;
        yield* Scope.close(scope, Exit.void);
        expect(snapshot.state.nodes).toEqual([
          { nodeId: "task", status: DagNodeStatus.Cancelled, reason: "explicit run cancellation" },
        ]);
        expect(yield* Ref.get(finalizers)).toBe(1);
      }),
  );

  it.effect("rejects same-graph non-fresh initial state before executor lookup", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const fresh = createDagRunState<unknown, unknown, DagFailedNodePayload>(dag);
      const started = reduceDagRunState(dag, fresh, {
        runId: dag.runId,
        nodeId: "task",
        type: DagTransitionType.Start,
      });
      if (started._tag !== "applied") throw new Error("fixture start transition failed");
      const lookupCount = yield* Ref.make(0);
      const service: DagExecutorRegistryService = {
        lookup: () =>
          Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(Effect.as(undefined)),
      };
      const exit = yield* Effect.exit(
        submitDagRun(dag, started.state).pipe(Effect.provide(runtimeLayer(service)), Effect.scoped),
      );
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("DagRuntimeNonFreshInitialState");
      expect(yield* Ref.get(lookupCount)).toBe(0);
    }),
  );

  it.effect("does not clean up the run when one await observer is interrupted", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { service } = registryFromMap({
        task: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ done: true }),
          ),
      });
      const scope = yield* Scope.make();
      const handle = yield* submitDagRun(dag).pipe(
        Effect.provide(runtimeLayer(service)),
        Scope.provide(scope),
      );
      yield* Deferred.await(started);
      const observerScope = yield* Scope.make();
      const observer = yield* handle.await.pipe(Effect.forkIn(observerScope));
      yield* Fiber.interrupt(observer);
      const interrupted = yield* Fiber.await(observer);
      yield* Scope.close(observerScope, Exit.void);
      expect(interrupted._tag).toBe("Failure");
      yield* Deferred.succeed(release, undefined);
      const snapshot = yield* handle.await;
      yield* Scope.close(scope, Exit.void);
      expect(snapshot.state.nodes).toEqual([
        { nodeId: "task", status: DagNodeStatus.Succeeded, outputs: { done: true } },
      ]);
    }),
  );

  it.effect(
    "preserves explicit cancellation if caller scope shutdown races after cancel is queued",
    () =>
      Effect.gen(function* () {
        const dag = graph([runtimeNode("task")]);
        const started = yield* Deferred.make<void>();
        const { service } = registryFromMap({
          task: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.as({})),
        });
        const scope = yield* Scope.make();
        const handle = yield* submitDagRun(dag).pipe(
          Effect.provide(runtimeLayer(service)),
          Scope.provide(scope),
        );
        yield* Deferred.await(started);
        const cancelScope = yield* Scope.make();
        const cancelFiber = yield* handle.cancel.pipe(Effect.forkIn(cancelScope));
        yield* Effect.yieldNow;
        yield* Scope.close(scope, Exit.void);
        const snapshot = yield* Fiber.join(cancelFiber);
        yield* Scope.close(cancelScope, Exit.void);
        expect(snapshot.outcome).toEqual({
          _tag: DagRunOutcomeResultTag.Terminal,
          outcome: DagRunOutcome.Cancelled,
        });
        expect(snapshot.state.nodes[0]).toMatchObject({ status: DagNodeStatus.Cancelled });
      }),
  );

  it.effect("applies completion guards when settled dependencies do not include a success", () =>
    Effect.gen(function* () {
      const dag = graph([
        runtimeNode("review-a"),
        runtimeNode("review-b"),
        runtimeNode(
          "synthesize",
          "synthesize",
          [
            dependency("review-a", DagDependencyMode.Settled),
            dependency("review-b", DagDependencyMode.Settled),
          ],
          {
            kind: DagCompletionGuardKind.AtLeastOneSucceeded,
            dependencyIds: ["review-a", "review-b"],
          },
        ),
      ]);
      const { service } = registryFromMap({
        "review-a": () => Effect.fail("a"),
        "review-b": () => Effect.fail("b"),
        synthesize: () => Effect.succeed({ impossible: true }),
      });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );
      expect(snapshot.state.nodes[2]).toEqual({
        nodeId: "synthesize",
        status: DagNodeStatus.Blocked,
        reason: DagBlockedReason.CompletionGuard,
        blockedBy: ["review-a", "review-b"],
      });
    }),
  );

  it.effect("records running before terminal attempt state", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const { service } = registryFromMap({
        task: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as({ done: true }),
          ),
      });
      const scope = yield* Scope.make();
      const handle = yield* submitDagRun(dag).pipe(
        Effect.provide(runtimeLayer(service)),
        Scope.provide(scope),
      );
      yield* Deferred.await(started);
      expect((yield* handle.snapshot).attempts).toEqual([
        {
          nodeId: "task",
          attemptId: "run-test:task:1",
          ordinal: 1,
          statuses: [DagNodeStatus.Running],
        },
      ]);
      yield* Deferred.succeed(gate, undefined);
      expect((yield* handle.await).attempts).toEqual([
        {
          nodeId: "task",
          attemptId: "run-test:task:1",
          ordinal: 1,
          statuses: [DagNodeStatus.Running, DagNodeResultTag.Succeeded],
        },
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("marks cancellation before any start without executor invocation", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const lookupCount = yield* Ref.make(0);
      const service: DagExecutorRegistryService = {
        lookup: () =>
          Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(Effect.as(undefined)),
      };
      const scope = yield* Scope.make();
      const handle = yield* submitDagRun(dag).pipe(
        Effect.provide(runtimeLayer(service)),
        Scope.provide(scope),
      );
      const snapshot = yield* handle.cancel;
      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(lookupCount)).toBe(0);
      expect(snapshot.state.nodes).toEqual([
        { nodeId: "task", status: DagNodeStatus.Cancelled, reason: "explicit run cancellation" },
      ]);
      expect(snapshot.attempts).toEqual([]);
      expect(snapshot.outcome).toEqual({
        _tag: DagRunOutcomeResultTag.Terminal,
        outcome: DagRunOutcome.Cancelled,
      });
    }),
  );

  it.effect("cancels a running executor and reaches terminal cancelled outcome", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalizers = yield* Ref.make(0);
      const { service } = registryFromMap({
        task: () =>
          Effect.acquireRelease(Effect.as(Deferred.succeed(started, undefined), undefined), () =>
            Ref.update(finalizers, (count) => count + 1),
          ).pipe(Effect.andThen(Deferred.await(release)), Effect.as({})),
      });
      const scope = yield* Scope.make();
      const handle = yield* submitDagRun(dag).pipe(
        Effect.provide(runtimeLayer(service)),
        Scope.provide(scope),
      );
      yield* Deferred.await(started);
      const snapshot = yield* handle.cancel;
      yield* Scope.close(scope, Exit.void);
      expect(snapshot.state.nodes).toEqual([
        { nodeId: "task", status: DagNodeStatus.Cancelled, reason: "explicit run cancellation" },
      ]);
      expect(snapshot.attempts).toEqual([
        {
          nodeId: "task",
          attemptId: "run-test:task:1",
          ordinal: 1,
          statuses: [DagNodeStatus.Running, DagNodeResultTag.Cancelled],
        },
      ]);
      expect(yield* Ref.get(finalizers)).toBe(1);
    }),
  );

  it.effect("interrupts owned runs on scope close and executes finalizers", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const finalizers = yield* Ref.make(0);
      const started = yield* Deferred.make<void>();
      const childScope = yield* Scope.make();
      const { service } = registryFromMap({
        task: () =>
          Effect.acquireRelease(Effect.as(Deferred.succeed(started, undefined), undefined), () =>
            Ref.update(finalizers, (count) => count + 1),
          ).pipe(Effect.andThen(Effect.never)),
      });
      const handle = yield* submitDagRun(dag).pipe(
        Effect.provide(runtimeLayer(service)),
        Scope.provide(childScope),
      );
      yield* Deferred.await(started);
      yield* Scope.close(childScope, Exit.void);
      const snapshot = yield* handle.await;
      expect(snapshot.state.nodes).toEqual([
        { nodeId: "task", status: DagNodeStatus.Interrupted, reason: "scope interruption" },
      ]);
      expect(snapshot.attempts).toEqual([
        {
          nodeId: "task",
          attemptId: "run-test:task:1",
          ordinal: 1,
          statuses: [DagNodeStatus.Running, DagNodeResultTag.Interrupted],
        },
      ]);
      expect(snapshot.outcome).toEqual({
        _tag: DagRunOutcomeResultTag.Terminal,
        outcome: DagRunOutcome.Interrupted,
      });
      expect(yield* Ref.get(finalizers)).toBe(1);
    }),
  );

  it.effect("rejects initial state from a different graph before executor lookup", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const other = graph([runtimeNode("task")]);
      const lookupCount = yield* Ref.make(0);
      const service: DagExecutorRegistryService = {
        lookup: () =>
          Ref.updateAndGet(lookupCount, (count) => count + 1).pipe(Effect.as(undefined)),
      };
      const exit = yield* Effect.exit(
        submitDagRun(dag, createDagRunState<unknown, unknown, DagFailedNodePayload>(other)).pipe(
          Effect.provide(runtimeLayer(service)),
          Effect.scoped,
        ),
      );
      expect(exit._tag).toBe("Failure");
      expect(String(exit)).toContain("DagRuntimeGraphStateMismatch");
      expect(yield* Ref.get(lookupCount)).toBe(0);
    }),
  );

  it.effect("publishes deeply immutable runtime snapshots", () =>
    Effect.gen(function* () {
      const dag = graph([runtimeNode("task")]);
      const { service } = registryFromMap({ task: () => Effect.succeed({ artifact: "ok" }) });
      const snapshot = yield* submitDagRun(dag).pipe(
        Effect.flatMap((handle) => handle.await),
        Effect.provide(runtimeLayer(service)),
        Effect.scoped,
      );

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.outcome)).toBe(true);
      expect(Object.isFrozen(snapshot.transitions)).toBe(true);
      expect(Object.isFrozen(snapshot.attempts)).toBe(true);
      expect(Object.isFrozen(snapshot.attempts[0])).toBe(true);
      expect(Object.isFrozen(snapshot.attempts[0]?.statuses)).toBe(true);
      expect(Object.isFrozen(snapshot.state)).toBe(true);
      expect(Object.isFrozen(snapshot.state.nodes)).toBe(true);
      expect(Object.isFrozen(snapshot.state.nodes[0])).toBe(true);
    }),
  );

  it.effect("has no executor fiber or finalizer leak after completion and cancellation", () =>
    Effect.gen(function* () {
      const finalizers = yield* Ref.make(0);
      const makeExecutor = (started: Deferred.Deferred<void>, gate: Deferred.Deferred<void>) =>
        Effect.acquireRelease(Effect.as(Deferred.succeed(started, undefined), undefined), () =>
          Ref.update(finalizers, (count) => count + 1),
        ).pipe(Effect.andThen(Deferred.await(gate)), Effect.as({}));

      const completionStarted = yield* Deferred.make<void>();
      const completionGate = yield* Deferred.make<void>();
      const completionScope = yield* Scope.make();
      const completionHandle = yield* submitDagRun(graph([runtimeNode("done")])).pipe(
        Effect.provide(
          runtimeLayer(
            registryFromMap({ done: () => makeExecutor(completionStarted, completionGate) })
              .service,
          ),
        ),
        Scope.provide(completionScope),
      );
      yield* Deferred.await(completionStarted);
      yield* Deferred.succeed(completionGate, undefined);
      const completionSnapshot = yield* completionHandle.await;
      yield* Scope.close(completionScope, Exit.void);
      expect(completionSnapshot.outcome).toEqual({
        _tag: DagRunOutcomeResultTag.Terminal,
        outcome: DagRunOutcome.Succeeded,
      });

      const cancelStarted = yield* Deferred.make<void>();
      const cancelGate = yield* Deferred.make<void>();
      const cancelScope = yield* Scope.make();
      const cancelHandle = yield* submitDagRun(graph([runtimeNode("cancel")])).pipe(
        Effect.provide(
          runtimeLayer(
            registryFromMap({ cancel: () => makeExecutor(cancelStarted, cancelGate) }).service,
          ),
        ),
        Scope.provide(cancelScope),
      );
      yield* Deferred.await(cancelStarted);
      const cancelSnapshot = yield* cancelHandle.cancel;
      yield* Scope.close(cancelScope, Exit.void);
      expect(cancelSnapshot.outcome).toEqual({
        _tag: DagRunOutcomeResultTag.Terminal,
        outcome: DagRunOutcome.Cancelled,
      });
      expect(yield* Ref.get(finalizers)).toBe(2);
    }),
  );
});
