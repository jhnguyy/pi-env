import { Effect } from "effect";
import {
  DagNodeStatus,
  type DagDefinition,
  type DagRunOutcome,
  type DagTransition,
} from "../contracts.js";
import {
  DagRunOutcomeResultTag,
  createDagRunState,
  deriveDagRunOutcome,
  type DagRunState,
} from "../kernel.js";
import type { ValidatedDagDefinition } from "../validation.js";
import {
  byteSize,
  computeDagSessionGraphId,
  computeTransitionAttemptUpdate,
  decodeOutcome,
  deepFreeze,
  validateGraph,
  validateLimits,
} from "./codec.js";
import { applyTransition } from "./replay.js";
import {
  DagSessionEntryType,
  DagSessionFinalInconsistent,
  DagSessionGraphMismatch,
  DagSessionLimitExceeded,
  DagSessionOrdering,
  DagSessionRunMismatch,
  DagSessionSeamFailed,
  DagSessionWireVersion,
  toSessionFailure,
  type DagSessionAttempt,
  type DagSessionAttemptStatus,
  type DagSessionEntry,
  type DagSessionFailure,
  type DagSessionLimits,
  type DagSessionManagerSeam,
} from "./contracts.js";

export interface DagSessionWriter {
  readonly appendGraph: (
    graph: DagDefinition<unknown>,
  ) => Effect.Effect<DagSessionEntry, DagSessionFailure>;
  readonly appendTransition: (
    transition: DagTransition<unknown, unknown>,
    attempt?: DagSessionAttemptStatus,
  ) => Effect.Effect<DagSessionEntry, DagSessionFailure>;
  readonly appendFinal: (
    outcome: DagRunOutcome,
  ) => Effect.Effect<DagSessionEntry, DagSessionFailure>;
}

function appendCustomEntry(seam: DagSessionManagerSeam, entry: DagSessionEntry): void {
  try {
    seam.appendCustomEntry(DagSessionEntryType, entry);
  } catch (cause) {
    throw new DagSessionSeamFailed({ operation: "appendCustomEntry", cause });
  }
}

export function makeDagSessionWriter(
  seam: DagSessionManagerSeam,
  graph: ValidatedDagDefinition<unknown>,
  graphDefinition: DagDefinition<unknown>,
  options?: { readonly limits?: Partial<DagSessionLimits> },
): DagSessionWriter {
  const limits = validateLimits(options?.limits);
  const graphId = computeDagSessionGraphId(graphDefinition);
  const validatedGraphId = computeDagSessionGraphId(graph);
  let seq = 0;
  let state: DagRunState<unknown, unknown> = createDagRunState(graph);
  let final = false;
  const attempts = new Map<string, DagSessionAttempt>();
  const append = (entry: DagSessionEntry) => {
    if (entry.seq >= limits.totalMatchingEntries)
      throw new DagSessionLimitExceeded({
        limit: "totalMatchingEntries",
        actual: entry.seq + 1,
        max: limits.totalMatchingEntries,
      });
    const frozen = deepFreeze(entry);
    const size = byteSize(frozen);
    const sizeLimit = entry.event._tag === "graph" ? limits.graphBytes : limits.eventBytes;
    const limitName = entry.event._tag === "graph" ? "graphBytes" : "eventBytes";
    if (size > sizeLimit)
      throw new DagSessionLimitExceeded({ limit: limitName, actual: size, max: sizeLimit });
    appendCustomEntry(seam, frozen);
    return frozen;
  };
  return {
    appendGraph: (definition) =>
      Effect.try({
        try: () => {
          if (seq !== 0)
            throw new DagSessionOrdering({ message: "graph must be appended exactly once" });
          validateGraph(definition, graphId, limits);
          if (validatedGraphId !== graphId)
            throw new DagSessionGraphMismatch({
              expectedGraphId: graphId,
              actualGraphId: validatedGraphId,
            });
          const entry = {
            v: DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: { _tag: "graph", graph: definition },
          } satisfies DagSessionEntry;
          const persisted = append(entry);
          seq += 1;
          return persisted;
        },
        catch: toSessionFailure,
      }),
    appendTransition: (transition, attempt) =>
      Effect.try({
        try: () => {
          if (final) throw new DagSessionOrdering({ message: "cannot append after final" });
          if (seq === 0) throw new DagSessionOrdering({ message: "graph must be appended first" });
          if (transition.runId !== graph.runId)
            throw new DagSessionRunMismatch({
              expectedRunId: graph.runId,
              actualRunId: transition.runId,
            });
          if (seq - 1 >= limits.transitions)
            throw new DagSessionLimitExceeded({
              limit: "transitions",
              actual: seq,
              max: limits.transitions,
            });
          const wasRunning = state.nodes.some(
            (node) => node.nodeId === transition.nodeId && node.status === DagNodeStatus.Running,
          );
          const applied = applyTransition(graph, state, transition);
          const attemptUpdate = computeTransitionAttemptUpdate(
            applied.transition,
            wasRunning,
            attempt,
            attempts.get(applied.transition.nodeId),
            graph.runId,
          );
          const entry = {
            v: DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: {
              _tag: "transition",
              transition: applied.transition,
              ...(attempt ? { attempt } : {}),
            },
          } satisfies DagSessionEntry;
          const persisted = append(entry);
          state = applied.state;
          if (attemptUpdate) attempts.set(attemptUpdate.nodeId, attemptUpdate);
          seq += 1;
          return persisted;
        },
        catch: toSessionFailure,
      }),
    appendFinal: (outcome) =>
      Effect.try({
        try: () => {
          if (final) throw new DagSessionOrdering({ message: "cannot append after final" });
          if (seq === 0) throw new DagSessionOrdering({ message: "graph must be appended first" });
          decodeOutcome(outcome, outcome);
          const derived = deriveDagRunOutcome(graph, state);
          if (derived._tag !== DagRunOutcomeResultTag.Terminal || derived.outcome !== outcome)
            throw new DagSessionFinalInconsistent({
              message: "final outcome does not match state",
            });
          const entry = {
            v: DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: { _tag: "final", outcome },
          } satisfies DagSessionEntry;
          const persisted = append(entry);
          final = true;
          seq += 1;
          return persisted;
        },
        catch: toSessionFailure,
      }),
  };
}
