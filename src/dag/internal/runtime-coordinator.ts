import { Cause, Deferred, Effect, Exit, Fiber, Option, Queue, Ref, Scope } from "effect";
import * as DagContracts from "../contracts.js";
import * as DagKernel from "../kernel.js";
import * as RuntimeContracts from "../runtime-contracts.js";
import type * as DagValidation from "../validation.js";

interface RuntimeMutable {
  readonly graph: DagValidation.ValidatedDagDefinition<unknown>;
  readonly state: DagKernel.DagRunState<unknown, RuntimeContracts.DagFailedNodePayload>;
  readonly transitions: readonly DagContracts.DagTransition<
    unknown,
    RuntimeContracts.DagFailedNodePayload
  >[];
  readonly attempts: readonly RuntimeContracts.DagNodeAttempt[];
  readonly active: ReadonlyMap<string, Fiber.Fiber<void, never>>;
  readonly cancelRequested: boolean;
}

type Completion = {
  readonly _tag: "complete";
  readonly nodeId: string;
  readonly result: DagContracts.DagNodeResult<unknown, RuntimeContracts.DagFailedNodePayload>;
};

type RuntimeEvent =
  | Completion
  | { readonly _tag: "cancel"; readonly reason: string }
  | { readonly _tag: "shutdown" };

function freezeAttempt(attempt: RuntimeContracts.DagNodeAttempt): RuntimeContracts.DagNodeAttempt {
  return Object.freeze({ ...attempt, statuses: Object.freeze([...attempt.statuses]) });
}

function snapshot(mutable: RuntimeMutable): RuntimeContracts.DagRunSnapshot {
  return Object.freeze({
    state: mutable.state,
    outcome: Object.freeze(DagKernel.deriveDagRunOutcome(mutable.graph, mutable.state)),
    transitions: Object.freeze([...mutable.transitions]),
    attempts: Object.freeze(mutable.attempts.map(freezeAttempt)),
  });
}

function applyTransition(
  mutable: RuntimeMutable,
  transition: DagContracts.DagTransition<unknown, RuntimeContracts.DagFailedNodePayload>,
): Effect.Effect<RuntimeMutable, RuntimeContracts.DagRuntimeReducerFatal> {
  const reduced = DagKernel.reduceDagRunState(mutable.graph, mutable.state, transition);
  if (reduced._tag !== "applied") {
    return Effect.fail(
      new RuntimeContracts.DagRuntimeReducerFatal({
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
): DagContracts.DagNodeResult<unknown, RuntimeContracts.DagFailedNodePayload> {
  if (Cause.hasInterruptsOnly(cause)) {
    return {
      _tag: cancelled
        ? DagContracts.DagNodeResultTag.Cancelled
        : DagContracts.DagNodeResultTag.Interrupted,
      reason: cancelled ? "explicit run cancellation" : "scope interruption",
    } as const;
  }
  if (Cause.hasDies(cause)) {
    return {
      _tag: DagContracts.DagNodeResultTag.Failed,
      failure: new RuntimeContracts.DagExecutorDefected({
        message: "DAG executor defected.",
        defect: Cause.squash(cause),
      }),
    } as const;
  }
  const error = Cause.findErrorOption(cause);
  const failure = Option.isSome(error) ? error.value : Cause.squash(cause);
  if (failure instanceof RuntimeContracts.DagExecutorMissing) {
    return { _tag: DagContracts.DagNodeResultTag.Failed, failure };
  }
  return {
    _tag: DagContracts.DagNodeResultTag.Failed,
    failure: new RuntimeContracts.DagExecutorFailed({
      message: "DAG executor failed.",
      error: failure,
    }),
  };
}

function journalFailed(cause: Cause.Cause<unknown>) {
  const error = Cause.findErrorOption(cause);
  return new RuntimeContracts.DagRuntimeJournalFailed({
    message: "DAG runtime journal append failed.",
    cause: Option.isSome(error) ? error.value : Cause.squash(cause),
  });
}

function runJournal<A>(
  effect: Effect.Effect<A, unknown>,
): Effect.Effect<A, RuntimeContracts.DagRuntimeJournalFailed> {
  return effect.pipe(Effect.catchCause((cause) => Effect.fail(journalFailed(cause))));
}

function trackJournal(
  journal: RuntimeContracts.DagRuntimeJournal,
  active: Ref.Ref<boolean>,
): RuntimeContracts.DagRuntimeJournal {
  const track = <A, E>(effect: Effect.Effect<A, E>) =>
    Ref.set(active, true).pipe(Effect.andThen(effect), Effect.ensuring(Ref.set(active, false)));
  return {
    beforeRun: (graph) => track(journal.beforeRun(graph)),
    appendTransition: (transition, attempt) => track(journal.appendTransition(transition, attempt)),
    appendFinal: (outcome) => track(journal.appendFinal(outcome)),
  };
}

function appendJournalTransition(
  journal: RuntimeContracts.DagRuntimeJournal | undefined,
  transition: DagContracts.DagTransition<unknown, RuntimeContracts.DagFailedNodePayload>,
  attempt?: RuntimeContracts.DagRuntimeJournalAttemptStatus,
) {
  return journal ? runJournal(journal.appendTransition(transition, attempt)) : Effect.void;
}

function publishTransition(
  mutableRef: Ref.Ref<RuntimeMutable>,
  mutable: RuntimeMutable,
  transition: DagContracts.DagTransition<unknown, RuntimeContracts.DagFailedNodePayload>,
  journal?: RuntimeContracts.DagRuntimeJournal,
  attempt?: RuntimeContracts.DagRuntimeJournalAttemptStatus,
): Effect.Effect<
  RuntimeMutable,
  RuntimeContracts.DagRuntimeReducerFatal | RuntimeContracts.DagRuntimeJournalFailed
> {
  return Effect.gen(function* () {
    let next = yield* applyTransition(mutable, transition);
    const accepted = next.transitions[next.transitions.length - 1];
    if (attempt) {
      const existing = next.attempts.find((candidate) => candidate.nodeId === attempt.nodeId);
      next = {
        ...next,
        attempts: existing
          ? Object.freeze(
              next.attempts.map((candidate) =>
                candidate.nodeId === attempt.nodeId
                  ? freezeAttempt({
                      ...candidate,
                      statuses: Object.freeze([...candidate.statuses, attempt.status]),
                    })
                  : candidate,
              ),
            )
          : Object.freeze([
              ...next.attempts,
              freezeAttempt({
                nodeId: attempt.nodeId,
                attemptId: attempt.attemptId,
                ordinal: attempt.ordinal,
                statuses: Object.freeze([attempt.status]),
              }),
            ]),
      };
    }
    yield* appendJournalTransition(journal, accepted, attempt);
    yield* Ref.set(mutableRef, next);
    return next;
  });
}

function runNode<TPayload>(
  graph: DagValidation.ValidatedDagDefinition<TPayload>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  events: Queue.Queue<RuntimeEvent>,
  node: DagContracts.DagNode<TPayload>,
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
            const registry = yield* RuntimeContracts.DagExecutorRegistry;
            const executor = yield* registry.lookup(node.executor.kind, node.executor.key);
            if (!executor) {
              return yield* new RuntimeContracts.DagExecutorMissing({
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
              _tag: DagContracts.DagNodeResultTag.Succeeded,
              outputs: Object.freeze({ ...exit.value }),
            } as const)
          : completeForCause(exit.cause, latest.cancelRequested || latestBefore.cancelRequested);
      yield* Queue.offer(events, { _tag: "complete", nodeId: node.id, result });
    }),
  );
}

function applyCompletion(
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  mutable: RuntimeMutable,
  event: Completion,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  return Effect.gen(function* () {
    let next = mutable;
    if (
      next.state.nodes.find((node) => node.nodeId === event.nodeId)?.status ===
      DagContracts.DagNodeStatus.Running
    ) {
      const attempt = next.attempts.find((candidate) => candidate.nodeId === event.nodeId);
      next = yield* publishTransition(
        mutableRef,
        next,
        {
          runId: graph.runId,
          nodeId: event.nodeId,
          type: DagContracts.DagTransitionType.Complete,
          result: event.result,
        },
        journal,
        attempt
          ? {
              nodeId: attempt.nodeId,
              attemptId: attempt.attemptId,
              ordinal: attempt.ordinal,
              status: event.result._tag,
            }
          : undefined,
      );
    }
    const active = new Map(next.active);
    active.delete(event.nodeId);
    next = { ...next, active };
    yield* Ref.set(mutableRef, next);
    return next;
  });
}

function drainActiveCompletions(
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  mutable: RuntimeMutable,
  events: Queue.Queue<RuntimeEvent>,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  return Effect.gen(function* () {
    let next = mutable;
    const expected = new Set(next.active.keys());
    for (const fiber of next.active.values()) yield* Fiber.interrupt(fiber);
    while (expected.size > 0) {
      const event = yield* Queue.take(events);
      if (event._tag !== "complete" || !expected.has(event.nodeId)) continue;
      expected.delete(event.nodeId);
      next = yield* applyCompletion(graph, mutableRef, next, event, journal);
    }
    return next;
  });
}

function interruptAndJoinActive(mutable: RuntimeMutable) {
  return Effect.forEach(mutable.active.values(), (fiber) => Fiber.interrupt(fiber), {
    discard: true,
  });
}

function startReadyNodes<TPayload>(
  graph: DagValidation.ValidatedDagDefinition<TPayload>,
  nodesById: ReadonlyMap<string, DagContracts.DagNode<TPayload>>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  events: Queue.Queue<RuntimeEvent>,
  runScope: Scope.Scope,
  mutable: RuntimeMutable,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  return Effect.gen(function* () {
    const step = DagKernel.deriveDagSchedulingStep(graph, mutable.state);
    let next = mutable;
    for (const transition of step.transitions) {
      next = yield* publishTransition(mutableRef, next, transition, journal);
    }
    const starts: {
      readonly nodeId: string;
      readonly node: DagContracts.DagNode<TPayload>;
      readonly startPermit: Deferred.Deferred<void>;
    }[] = [];
    for (const nodeId of step.readyNodeIds) {
      const node = nodesById.get(nodeId);
      if (!node) continue;
      next = yield* publishTransition(
        mutableRef,
        next,
        { runId: graph.runId, nodeId, type: DagContracts.DagTransitionType.Start },
        journal,
        {
          nodeId,
          attemptId: `${graph.runId}:${nodeId}:1`,
          ordinal: 1,
          status: DagContracts.DagNodeStatus.Running,
        },
      );
      starts.push({ nodeId, node, startPermit: yield* Deferred.make<void>() });
    }
    for (const start of starts) {
      const fiber = yield* runNode(graph, mutableRef, events, start.node, start.startPermit).pipe(
        Effect.forkIn(runScope, { startImmediately: true }),
      );
      next = { ...next, active: new Map([...next.active, [start.nodeId, fiber]]) };
    }
    yield* Ref.set(mutableRef, next);
    for (const start of starts) yield* Deferred.succeed(start.startPermit, undefined);
    return next;
  });
}

function finishIfTerminal(
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  mutable: RuntimeMutable,
  done: Deferred.Deferred<RuntimeContracts.DagRunSnapshot, RuntimeContracts.DagRunAwaitError>,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  return Effect.gen(function* () {
    const outcome = DagKernel.deriveDagRunOutcome(graph, mutable.state);
    if (outcome._tag === DagKernel.DagRunOutcomeResultTag.NonTerminal) return false;
    if (journal) yield* runJournal(journal.appendFinal(outcome.outcome));
    yield* Deferred.succeed(done, snapshot(mutable));
    return true;
  });
}

function processRuntimeEvent<TPayload>(
  graph: DagValidation.ValidatedDagDefinition<TPayload>,
  nodesById: ReadonlyMap<string, DagContracts.DagNode<TPayload>>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  events: Queue.Queue<RuntimeEvent>,
  runScope: Scope.Scope,
  mutable: RuntimeMutable,
  event: RuntimeEvent,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  return Effect.gen(function* () {
    let next = mutable;
    if (event._tag === "cancel") {
      next = { ...next, cancelRequested: true };
      yield* Ref.set(mutableRef, next);
      next = yield* drainActiveCompletions(graph, mutableRef, next, events, journal);
      return yield* cancelQueued(mutableRef, next, event.reason, journal);
    }
    if (event._tag === "shutdown") {
      if (next.cancelRequested) {
        next = yield* drainActiveCompletions(graph, mutableRef, next, events, journal);
        return yield* cancelQueued(mutableRef, next, "explicit run cancellation", journal);
      }
      next = { ...next, cancelRequested: false };
      yield* Ref.set(mutableRef, next);
      next = yield* drainActiveCompletions(graph, mutableRef, next, events, journal);
      return yield* interruptQueued(mutableRef, next, journal);
    }
    next = yield* applyCompletion(graph, mutableRef, next, event, journal);
    return yield* startReadyNodes(graph, nodesById, mutableRef, events, runScope, next, journal);
  });
}

function coordinator<TPayload>(
  graph: DagValidation.ValidatedDagDefinition<TPayload>,
  mutableRef: Ref.Ref<RuntimeMutable>,
  events: Queue.Queue<RuntimeEvent>,
  done: Deferred.Deferred<RuntimeContracts.DagRunSnapshot, RuntimeContracts.DagRunAwaitError>,
  runScope: Scope.Scope,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  return Effect.gen(function* () {
    if (journal) yield* runJournal(journal.beforeRun(graph));
    yield* Effect.yieldNow;
    let mutable = yield* Ref.get(mutableRef);
    const firstEvent = yield* Queue.poll(events);
    if (Option.isSome(firstEvent)) {
      mutable = yield* processRuntimeEvent(
        graph,
        nodesById,
        mutableRef,
        events,
        runScope,
        mutable,
        firstEvent.value,
        journal,
      );
      if (yield* finishIfTerminal(graph, mutable, done, journal)) return;
    }
    mutable = yield* startReadyNodes(
      graph,
      nodesById,
      mutableRef,
      events,
      runScope,
      mutable,
      journal,
    );
    while (!(yield* finishIfTerminal(graph, mutable, done, journal))) {
      const event = yield* Queue.take(events);
      mutable = yield* processRuntimeEvent(
        graph,
        nodesById,
        mutableRef,
        events,
        runScope,
        yield* Ref.get(mutableRef),
        event,
        journal,
      );
      yield* Ref.set(mutableRef, mutable);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const mutable = yield* Ref.get(mutableRef);
          yield* interruptAndJoinActive(mutable).pipe(Effect.ignore);
          const error = Cause.findErrorOption(cause);
          if (
            Option.isSome(error) &&
            (error.value instanceof RuntimeContracts.DagRuntimeReducerFatal ||
              error.value instanceof RuntimeContracts.DagRuntimeJournalFailed)
          ) {
            yield* Deferred.fail(done, error.value);
            return;
          }
          yield* Deferred.fail(
            done,
            new RuntimeContracts.DagRuntimeCoordinatorFatal({
              message: "DAG runtime coordinator failed.",
              cause: Cause.squash(cause),
            }),
          );
        }),
      ),
    ),
  );
}

function cancelQueued(
  mutableRef: Ref.Ref<RuntimeMutable>,
  mutable: RuntimeMutable,
  reason: string,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  return Effect.gen(function* () {
    let next = mutable;
    for (const node of next.state.nodes) {
      if (node.status === DagContracts.DagNodeStatus.Queued) {
        next = yield* publishTransition(
          mutableRef,
          next,
          {
            runId: next.graph.runId,
            nodeId: node.nodeId,
            type: DagContracts.DagTransitionType.Cancel,
            reason,
          },
          journal,
        );
      }
    }
    return next;
  });
}

function interruptQueued(
  mutableRef: Ref.Ref<RuntimeMutable>,
  mutable: RuntimeMutable,
  journal?: RuntimeContracts.DagRuntimeJournal,
) {
  return Effect.gen(function* () {
    let next = mutable;
    for (const node of next.state.nodes) {
      if (node.status === DagContracts.DagNodeStatus.Queued) {
        next = yield* publishTransition(
          mutableRef,
          next,
          {
            runId: next.graph.runId,
            nodeId: node.nodeId,
            type: DagContracts.DagTransitionType.Cancel,
            reason: "scope interruption projected through queued cancel transition",
          },
          journal,
        );
      }
    }
    return next;
  });
}

export const submitDagRunInternal = <TPayload>(
  graph: DagValidation.ValidatedDagDefinition<TPayload>,
  initialState?: DagKernel.DagRunState<unknown, RuntimeContracts.DagFailedNodePayload>,
  options?: RuntimeContracts.DagRuntimeSubmitOptions,
): Effect.Effect<
  RuntimeContracts.DagRunHandle,
  RuntimeContracts.DagRuntimeError,
  RuntimeContracts.DagExecutorRegistry | Scope.Scope
> =>
  Effect.gen(function* () {
    const state =
      initialState ??
      DagKernel.createDagRunState<TPayload, unknown, RuntimeContracts.DagFailedNodePayload>(graph);
    if (!state.belongsTo(graph)) {
      return yield* new RuntimeContracts.DagRuntimeGraphStateMismatch({
        message: "Initial DAG run state belongs to a different graph.",
        runId: graph.runId,
      });
    }
    if (
      initialState &&
      state.nodes.some((node) => node.status !== DagContracts.DagNodeStatus.Queued)
    ) {
      return yield* new RuntimeContracts.DagRuntimeNonFreshInitialState({
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
    const journalActive = yield* Ref.make(false);
    const journal = options?.journal ? trackJournal(options.journal, journalActive) : undefined;
    const events = yield* Queue.unbounded<RuntimeEvent>();
    const done = yield* Deferred.make<
      RuntimeContracts.DagRunSnapshot,
      RuntimeContracts.DagRunAwaitError
    >();
    yield* Effect.gen(function* () {
      const runScope = yield* Scope.make();
      const cleaned = yield* Ref.make(false);
      const fiber = yield* coordinator(graph, ref, events, done, runScope, journal).pipe(
        Effect.interruptible,
        Effect.forkIn(runScope, { startImmediately: true }),
      );
      const cleanup = Effect.gen(function* () {
        const shouldClean = yield* Ref.modify(cleaned, (wasCleaned) => [!wasCleaned, true]);
        if (!shouldClean) return;
        if (!(yield* Deferred.isDone(done))) {
          if (yield* Ref.get(journalActive)) {
            yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
            yield* Deferred.fail(
              done,
              new RuntimeContracts.DagRuntimeJournalFailed({
                message: "DAG runtime journal was interrupted during owner shutdown.",
                cause: new Error("Owner scope closed during a journal operation."),
              }),
            );
          } else {
            yield* Queue.offer(events, { _tag: "shutdown" });
          }
          yield* Deferred.await(done).pipe(Effect.ignore);
        }
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
        yield* Scope.close(runScope, Exit.void).pipe(Effect.ignore);
        yield* Queue.shutdown(events).pipe(Effect.ignore);
      });
      yield* Effect.addFinalizer(() => cleanup);
    });
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
