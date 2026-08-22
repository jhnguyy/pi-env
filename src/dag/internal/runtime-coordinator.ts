import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Ref, Scope } from "effect";
import {
  DagNodeResultTag,
  DagNodeStatus,
  DagTransitionType,
  type DagNode,
  type DagNodeResult,
  type DagTransition,
} from "../contracts.js";
import {
  DagRunOutcomeResultTag,
  createDagRunState,
  deriveDagRunOutcome,
  deriveDagSchedulingStep,
  reduceDagRunState,
} from "../kernel.js";
import type { DagRunState } from "../kernel.js";
import type { ValidatedDagDefinition } from "../validation.js";

import {
  DagExecutorDefected,
  DagExecutorFailed,
  DagExecutorMissing,
  DagExecutorRegistry,
  DagRuntimeCoordinatorFatal,
  DagRuntimeGraphStateMismatch,
  DagRuntimeNonFreshInitialState,
  DagRuntimeReducerFatal,
  type DagFailedNodePayload,
  type DagNodeAttempt,
  type DagRunHandle,
  type DagRunSnapshot,
  type DagRuntimeError,
} from "../runtime-contracts.js";

interface RuntimeMutable {
  readonly graph: ValidatedDagDefinition<unknown>;
  readonly state: DagRunState<unknown, DagFailedNodePayload>;
  readonly transitions: readonly DagTransition<unknown, DagFailedNodePayload>[];
  readonly attempts: readonly DagNodeAttempt[];
  readonly active: ReadonlyMap<string, Fiber.Fiber<void, never>>;
  readonly cancelRequested: boolean;
}

type Completion = {
  readonly _tag: "complete";
  readonly nodeId: string;
  readonly result: DagNodeResult<unknown, DagFailedNodePayload>;
};

type RuntimeEvent =
  | Completion
  | { readonly _tag: "cancel"; readonly reason: string }
  | { readonly _tag: "shutdown" };

function freezeAttempt(attempt: DagNodeAttempt): DagNodeAttempt {
  return Object.freeze({ ...attempt, statuses: Object.freeze([...attempt.statuses]) });
}

function snapshot(mutable: RuntimeMutable): DagRunSnapshot {
  return Object.freeze({
    state: mutable.state,
    outcome: Object.freeze(deriveDagRunOutcome(mutable.graph, mutable.state)),
    transitions: Object.freeze([...mutable.transitions]),
    attempts: Object.freeze(mutable.attempts.map(freezeAttempt)),
  });
}

function applyTransition(
  mutable: RuntimeMutable,
  transition: DagTransition<unknown, DagFailedNodePayload>,
): Effect.Effect<RuntimeMutable, DagRuntimeReducerFatal> {
  const reduced = reduceDagRunState(mutable.graph, mutable.state, transition);
  if (reduced._tag !== "applied") {
    return Effect.fail(
      new DagRuntimeReducerFatal({
        message: "DAG reducer rejected a runtime transition.",
        error: reduced.error,
      }),
    );
  }
  return Effect.succeed({
    ...mutable,
    state: reduced.state,
    transitions: Object.freeze([...mutable.transitions, reduced.transition]),
  });
}

function completeForCause(
  cause: Cause.Cause<unknown>,
  cancelled: boolean,
): DagNodeResult<unknown, DagFailedNodePayload> {
  if (Cause.hasInterruptsOnly(cause)) {
    return {
      _tag: cancelled ? DagNodeResultTag.Cancelled : DagNodeResultTag.Interrupted,
      reason: cancelled ? "explicit run cancellation" : "scope interruption",
    } as const;
  }
  if (Cause.hasDies(cause)) {
    return {
      _tag: DagNodeResultTag.Failed,
      failure: new DagExecutorDefected({
        message: "DAG executor defected.",
        defect: Cause.squash(cause),
      }),
    } as const;
  }
  const error = Cause.findErrorOption(cause);
  const failure = Option.isSome(error) ? error.value : Cause.squash(cause);
  if (failure instanceof DagExecutorMissing) {
    return { _tag: DagNodeResultTag.Failed, failure };
  }
  return {
    _tag: DagNodeResultTag.Failed,
    failure: new DagExecutorFailed({
      message: "DAG executor failed.",
      error: failure,
    }),
  };
}

function runNode<TPayload>(
  graph: ValidatedDagDefinition<TPayload>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  events: Queue.Queue<RuntimeEvent>,
  node: DagNode<TPayload>,
  startPermit: Deferred.Deferred<void>,
) {
  const attemptId = `${graph.runId}:${node.id}:1`;
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* Deferred.await(startPermit);
      const latestBefore = yield* Ref.get(mutableRef);
      const graphState = latestBefore.state;
      const exit = yield* Effect.exit(
        restore(
          Effect.gen(function* () {
            const registry = yield* DagExecutorRegistry;
            const executor = yield* registry.lookup(node.executor.kind, node.executor.key);
            if (!executor) {
              return yield* new DagExecutorMissing({
                message: "DAG executor was not found.",
                kind: node.executor.kind,
                key: node.executor.key,
              });
            }
            return yield* Effect.scoped(
              Effect.suspend(() =>
                executor({
                  runId: graph.runId,
                  node,
                  attemptId,
                  attemptOrdinal: 1,
                  graphState,
                }),
              ),
            );
          }),
        ),
      );
      const latest = yield* Ref.get(mutableRef);
      const result =
        exit._tag === "Success"
          ? ({
              _tag: DagNodeResultTag.Succeeded,
              outputs: Object.freeze({ ...exit.value }),
            } as const)
          : completeForCause(exit.cause, latest.cancelRequested || latestBefore.cancelRequested);
      yield* Queue.offer(events, { _tag: "complete", nodeId: node.id, result });
    }),
  );
}

function applyCompletion(
  graph: ValidatedDagDefinition<unknown>,
  mutable: RuntimeMutable,
  event: Completion,
) {
  return Effect.gen(function* () {
    const active = new Map(mutable.active);
    active.delete(event.nodeId);
    let next: RuntimeMutable = { ...mutable, active };
    if (
      next.state.nodes.find((node) => node.nodeId === event.nodeId)?.status ===
      DagNodeStatus.Running
    ) {
      next = yield* applyTransition(next, {
        runId: graph.runId,
        nodeId: event.nodeId,
        type: DagTransitionType.Complete,
        result: event.result,
      });
      next = {
        ...next,
        attempts: Object.freeze(
          next.attempts.map((attempt) =>
            attempt.nodeId === event.nodeId
              ? freezeAttempt({
                  ...attempt,
                  statuses: Object.freeze([...attempt.statuses, event.result._tag]),
                })
              : attempt,
          ),
        ),
      };
    }
    return next;
  });
}

function drainActiveCompletions(
  graph: ValidatedDagDefinition<unknown>,
  mutable: RuntimeMutable,
  events: Queue.Queue<RuntimeEvent>,
) {
  return Effect.gen(function* () {
    let next = mutable;
    const expected = new Set(next.active.keys());
    for (const fiber of next.active.values()) yield* Fiber.interrupt(fiber);
    while (expected.size > 0) {
      const event = yield* Queue.take(events);
      if (event._tag !== "complete" || !expected.has(event.nodeId)) continue;
      expected.delete(event.nodeId);
      next = yield* applyCompletion(graph, next, event);
    }
    return next;
  });
}

function interruptAndJoinActive(mutable: RuntimeMutable) {
  return Effect.forEach(mutable.active.values(), (fiber) => Fiber.interrupt(fiber), {
    discard: true,
  });
}

function coordinator<TPayload>(
  graph: ValidatedDagDefinition<TPayload>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  events: Queue.Queue<RuntimeEvent>,
  done: Deferred.Deferred<DagRunSnapshot, DagRuntimeReducerFatal | DagRuntimeCoordinatorFatal>,
  runScope: Scope.Scope,
) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return Effect.gen(function* () {
    const startReady = function* (mutable: RuntimeMutable) {
      const step = deriveDagSchedulingStep(graph, mutable.state);
      let next =
        step.state === mutable.state && step.transitions.length === 0
          ? mutable
          : {
              ...mutable,
              state: step.state,
              transitions: Object.freeze([...mutable.transitions, ...step.transitions]),
            };
      const newAttempts: DagNodeAttempt[] = [];
      const newActive = new Map(next.active);
      const newTransitions: DagTransition<unknown, DagFailedNodePayload>[] = [];
      const permits: Deferred.Deferred<void>[] = [];
      for (const nodeId of step.readyNodeIds) {
        const node = nodesById.get(nodeId);
        if (!node) continue;
        const reduced = reduceDagRunState(graph, next.state, {
          runId: graph.runId,
          nodeId,
          type: DagTransitionType.Start,
        });
        if (reduced._tag !== "applied") {
          return yield* new DagRuntimeReducerFatal({
            message: "DAG reducer rejected a runtime transition.",
            error: reduced.error,
          });
        }
        next = { ...next, state: reduced.state };
        newTransitions.push(reduced.transition);
        newAttempts.push(
          freezeAttempt({
            nodeId,
            attemptId: `${graph.runId}:${nodeId}:1`,
            ordinal: 1,
            statuses: Object.freeze([DagNodeStatus.Running]),
          }),
        );
        const startPermit = yield* Deferred.make<void>();
        const fiber = yield* runNode(graph, mutableRef, events, node, startPermit).pipe(
          Effect.forkIn(runScope, { startImmediately: true }),
        );
        newActive.set(nodeId, fiber);
        permits.push(startPermit);
      }
      next = {
        ...next,
        transitions: Object.freeze([...next.transitions, ...newTransitions]),
        attempts: Object.freeze([...next.attempts, ...newAttempts]),
        active: newActive,
      };
      yield* Ref.set(mutableRef, next);
      for (const permit of permits) yield* Deferred.succeed(permit, undefined);
      return next;
    };
    const finishIfTerminal = function* (mutable: RuntimeMutable) {
      if (deriveDagRunOutcome(graph, mutable.state)._tag === DagRunOutcomeResultTag.NonTerminal)
        return false;
      yield* Deferred.succeed(done, snapshot(mutable));
      return true;
    };

    yield* Effect.yieldNow;
    let mutable = yield* Ref.get(mutableRef);
    const firstEvent = yield* Queue.poll(events);
    if (Option.isSome(firstEvent) && firstEvent.value._tag === "cancel") {
      mutable = { ...mutable, cancelRequested: true };
      mutable = yield* cancelQueued(mutable, firstEvent.value.reason);
      yield* Ref.set(mutableRef, mutable);
      yield* Deferred.succeed(done, snapshot(mutable));
      return;
    }
    if (Option.isSome(firstEvent) && firstEvent.value._tag === "shutdown") {
      mutable = yield* interruptQueued(mutable);
      yield* Ref.set(mutableRef, mutable);
      yield* Deferred.succeed(done, snapshot(mutable));
      return;
    }
    mutable = yield* startReady(mutable);
    while (!(yield* finishIfTerminal(mutable))) {
      const event = yield* Queue.take(events);
      mutable = yield* Ref.get(mutableRef);
      if (event._tag === "cancel") {
        mutable = { ...mutable, cancelRequested: true };
        yield* Ref.set(mutableRef, mutable);
        mutable = yield* drainActiveCompletions(graph, mutable, events);
        mutable = yield* cancelQueued(mutable, event.reason);
      } else if (event._tag === "shutdown") {
        if (mutable.cancelRequested) {
          mutable = yield* drainActiveCompletions(graph, mutable, events);
          mutable = yield* cancelQueued(mutable, "explicit run cancellation");
        } else {
          mutable = { ...mutable, cancelRequested: false };
          yield* Ref.set(mutableRef, mutable);
          mutable = yield* drainActiveCompletions(graph, mutable, events);
          mutable = yield* interruptQueued(mutable);
        }
      } else {
        mutable = yield* applyCompletion(graph, mutable, event);
        mutable = yield* startReady(mutable);
      }
      yield* Ref.set(mutableRef, mutable);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const mutable = yield* Ref.get(mutableRef);
        yield* interruptAndJoinActive(mutable).pipe(Effect.ignore);
        const error = Cause.findErrorOption(cause);
        if (Option.isSome(error) && error.value instanceof DagRuntimeReducerFatal) {
          yield* Deferred.fail(done, error.value);
          return;
        }
        yield* Deferred.fail(
          done,
          new DagRuntimeCoordinatorFatal({
            message: "DAG runtime coordinator failed.",
            cause: Cause.squash(cause),
          }),
        );
      }),
    ),
  );
}

function cancelQueued(mutable: RuntimeMutable, reason: string) {
  return Effect.gen(function* () {
    let next = mutable;
    for (const node of next.state.nodes) {
      if (node.status === DagNodeStatus.Queued) {
        next = yield* applyTransition(next, {
          runId: next.graph.runId,
          nodeId: node.nodeId,
          type: DagTransitionType.Cancel,
          reason,
        });
      }
    }
    return next;
  });
}

function interruptQueued(mutable: RuntimeMutable) {
  return Effect.gen(function* () {
    let next = mutable;
    for (const node of next.state.nodes) {
      if (node.status === DagNodeStatus.Queued) {
        next = yield* applyTransition(next, {
          runId: next.graph.runId,
          nodeId: node.nodeId,
          type: DagTransitionType.Cancel,
          reason: "scope interruption projected through queued cancel transition",
        });
      }
    }
    return next;
  });
}

export const submitDagRunInternal = <TPayload>(
  graph: ValidatedDagDefinition<TPayload>,
  initialState?: DagRunState<unknown, DagFailedNodePayload>,
): Effect.Effect<DagRunHandle, DagRuntimeError, DagExecutorRegistry | Scope.Scope> =>
  Effect.gen(function* () {
    const state = initialState ?? createDagRunState<TPayload, unknown, DagFailedNodePayload>(graph);
    if (!state.belongsTo(graph)) {
      return yield* new DagRuntimeGraphStateMismatch({
        message: "Initial DAG run state belongs to a different graph.",
        runId: graph.runId,
      });
    }
    if (initialState && state.nodes.some((node) => node.status !== DagNodeStatus.Queued)) {
      return yield* new DagRuntimeNonFreshInitialState({
        message:
          "Same-graph initial DAG run state must be fresh; replay and resume are not supported by submitDagRun.",
        runId: graph.runId,
      });
    }
    const initial: RuntimeMutable = {
      graph,
      state,
      transitions: Object.freeze([]),
      attempts: Object.freeze([]),
      active: new Map(),
      cancelRequested: false,
    };
    const ref = yield* Ref.make(initial);
    const events = yield* Queue.unbounded<RuntimeEvent>();
    const done = yield* Deferred.make<
      DagRunSnapshot,
      DagRuntimeReducerFatal | DagRuntimeCoordinatorFatal
    >();
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const runScope = yield* Scope.make();
        const cleaned = yield* Ref.make(false);
        const fiber = yield* coordinator(graph, ref, events, done, runScope).pipe(
          Effect.forkIn(runScope, { startImmediately: true }),
        );
        const cleanup = Effect.gen(function* () {
          const shouldClean = yield* Ref.modify(cleaned, (wasCleaned) => [!wasCleaned, true]);
          if (!shouldClean) return;
          if (!(yield* Deferred.isDone(done))) {
            yield* Queue.offer(events, { _tag: "shutdown" });
            yield* Deferred.await(done).pipe(Effect.ignore);
          }
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
          yield* Scope.close(runScope, Exit.void).pipe(Effect.ignore);
          yield* Queue.shutdown(events).pipe(Effect.ignore);
        });
        yield* Effect.addFinalizer(() => cleanup);
      }),
    );
    const awaitSnapshot = Deferred.await(done);
    return Object.freeze({
      snapshot: Ref.get(ref).pipe(Effect.map(snapshot)),
      await: awaitSnapshot,
      cancel: Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* Deferred.isDone(done))) {
            yield* Queue.offer(events, { _tag: "cancel", reason: "explicit run cancellation" });
          }
          return yield* restore(awaitSnapshot);
        }),
      ),
    });
  });
