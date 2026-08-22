import { Effect } from "effect";
import * as DagContracts from "../contracts.js";
import * as DagKernel from "../kernel.js";
import type * as DagValidation from "../validation.js";
import * as SessionCodec from "./codec.js";
import * as SessionReplay from "./replay.js";
import * as SessionContracts from "./contracts.js";

export interface DagSessionWriter {
  readonly appendGraph: (
    graph: DagContracts.DagDefinition<unknown>,
  ) => Effect.Effect<SessionContracts.DagSessionEntry, SessionContracts.DagSessionFailure>;
  readonly appendTransition: (
    transition: DagContracts.DagTransition<unknown, unknown>,
    attempt?: SessionContracts.DagSessionAttemptStatus,
  ) => Effect.Effect<SessionContracts.DagSessionEntry, SessionContracts.DagSessionFailure>;
  readonly appendFinal: (
    outcome: DagContracts.DagRunOutcome,
  ) => Effect.Effect<SessionContracts.DagSessionEntry, SessionContracts.DagSessionFailure>;
}

function appendCustomEntry(seam: SessionContracts.DagSessionManagerSeam, entry: SessionContracts.DagSessionEntry): void {
  try {
    seam.appendCustomEntry(SessionContracts.DagSessionEntryType, entry);
  } catch (cause) {
    throw new SessionContracts.DagSessionSeamFailed({ operation: "appendCustomEntry", cause });
  }
}

export function makeDagSessionWriter(
  seam: SessionContracts.DagSessionManagerSeam,
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  graphDefinition: DagContracts.DagDefinition<unknown>,
  options?: { readonly limits?: Partial<SessionContracts.DagSessionLimits> },
): DagSessionWriter {
  const limits = SessionCodec.validateLimits(options?.limits);
  const graphId = SessionCodec.computeDagSessionGraphId(graphDefinition);
  const validatedGraphId = SessionCodec.computeDagSessionGraphId(graph);
  let seq = 0;
  let state: DagKernel.DagRunState<unknown, unknown> = DagKernel.createDagRunState(graph);
  let final = false;
  const attempts = new Map<string, SessionContracts.DagSessionAttempt>();
  const append = (entry: SessionContracts.DagSessionEntry) => {
    if (entry.seq >= limits.totalMatchingEntries)
      throw new SessionContracts.DagSessionLimitExceeded({
        limit: "totalMatchingEntries",
        actual: entry.seq + 1,
        max: limits.totalMatchingEntries,
      });
    const frozen = SessionCodec.deepFreeze(entry);
    const size = SessionCodec.byteSize(frozen);
    const sizeLimit = entry.event._tag === "graph" ? limits.graphBytes : limits.eventBytes;
    const limitName = entry.event._tag === "graph" ? "graphBytes" : "eventBytes";
    if (size > sizeLimit)
      throw new SessionContracts.DagSessionLimitExceeded({ limit: limitName, actual: size, max: sizeLimit });
    appendCustomEntry(seam, frozen);
    return frozen;
  };
  return {
    appendGraph: (definition) =>
      Effect.try({
        try: () => {
          if (seq !== 0)
            throw new SessionContracts.DagSessionOrdering({ message: "graph must be appended exactly once" });
          SessionCodec.validateGraph(definition, graphId, limits);
          if (validatedGraphId !== graphId)
            throw new SessionContracts.DagSessionGraphMismatch({
              expectedGraphId: graphId,
              actualGraphId: validatedGraphId,
            });
          const entry = {
            v: SessionContracts.DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: { _tag: "graph", graph: definition },
          } satisfies SessionContracts.DagSessionEntry;
          const persisted = append(entry);
          seq += 1;
          return persisted;
        },
        catch: SessionContracts.toSessionFailure,
      }),
    appendTransition: (transition, attempt) =>
      Effect.try({
        try: () => {
          if (final) throw new SessionContracts.DagSessionOrdering({ message: "cannot append after final" });
          if (seq === 0) throw new SessionContracts.DagSessionOrdering({ message: "graph must be appended first" });
          if (transition.runId !== graph.runId)
            throw new SessionContracts.DagSessionRunMismatch({
              expectedRunId: graph.runId,
              actualRunId: transition.runId,
            });
          if (seq - 1 >= limits.transitions)
            throw new SessionContracts.DagSessionLimitExceeded({
              limit: "transitions",
              actual: seq,
              max: limits.transitions,
            });
          const wasRunning = state.nodes.some(
            (node) => node.nodeId === transition.nodeId && node.status === DagContracts.DagNodeStatus.Running,
          );
          const applied = SessionReplay.applyTransition(graph, state, transition);
          const attemptUpdate = SessionCodec.computeTransitionAttemptUpdate(
            applied.transition,
            wasRunning,
            attempt,
            attempts.get(applied.transition.nodeId),
            graph.runId,
          );
          const entry = {
            v: SessionContracts.DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: {
              _tag: "transition",
              transition: applied.transition,
              ...(attempt ? { attempt } : {}),
            },
          } satisfies SessionContracts.DagSessionEntry;
          const persisted = append(entry);
          state = applied.state;
          if (attemptUpdate) attempts.set(attemptUpdate.nodeId, attemptUpdate);
          seq += 1;
          return persisted;
        },
        catch: SessionContracts.toSessionFailure,
      }),
    appendFinal: (outcome) =>
      Effect.try({
        try: () => {
          if (final) throw new SessionContracts.DagSessionOrdering({ message: "cannot append after final" });
          if (seq === 0) throw new SessionContracts.DagSessionOrdering({ message: "graph must be appended first" });
          SessionCodec.decodeOutcome(outcome, outcome);
          const derived = DagKernel.deriveDagRunOutcome(graph, state);
          if (derived._tag !== DagKernel.DagRunOutcomeResultTag.Terminal || derived.outcome !== outcome)
            throw new SessionContracts.DagSessionFinalInconsistent({
              message: "final outcome does not match state",
            });
          const entry = {
            v: SessionContracts.DagSessionWireVersion,
            runId: graph.runId,
            graphId,
            seq,
            event: { _tag: "final", outcome },
          } satisfies SessionContracts.DagSessionEntry;
          const persisted = append(entry);
          final = true;
          seq += 1;
          return persisted;
        },
        catch: SessionContracts.toSessionFailure,
      }),
  };
}
