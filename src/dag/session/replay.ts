import { Effect } from "effect";
import {
  DagNodeResultTag,
  DagNodeStatus,
  DagTransitionType,
  type DagTransition,
} from "../contracts.js";
import {
  DagRunOutcomeResultTag,
  DagTransitionResultTag,
  createDagRunState,
  deriveDagRunOutcome,
  deriveDagSchedulingStep,
  reduceDagRunState,
  type DagRunState,
} from "../kernel.js";
import { type ValidatedDagDefinition } from "../validation.js";
import {
  computeDagSessionGraphId,
  decodeEntry,
  deepFreeze,
  isRecord,
  recordAttempt,
  validateGraph,
  validateLimits,
} from "./codec.js";
import {
  DagSessionEntryType,
  DagSessionAttemptInconsistent,
  DagSessionDuplicate,
  DagSessionFinalInconsistent,
  DagSessionGraphMismatch,
  DagSessionLimitExceeded,
  DagSessionMalformed,
  DagSessionOrdering,
  DagSessionProcessLossReason,
  DagSessionReducerIllegal,
  DagSessionRunMismatch,
  DagSessionRunNotFound,
  DagSessionSeamFailed,
  DagSessionTruncated,
  toSessionFailure,
  type DagSessionAttempt,
  type DagSessionAttemptStatus,
  type DagSessionEntry,
  type DagSessionEvent,
  type DagSessionFailure,
  type DagSessionLimits,
  type DagSessionManagerSeam,
  type DagSessionReconstruction,
} from "./contracts.js";

function terminalStatus(
  transition: DagTransition<unknown, unknown>,
): DagSessionAttemptStatus["status"] | undefined {
  if (transition.type === DagTransitionType.Start) return DagNodeStatus.Running;
  if (transition.type === DagTransitionType.Cancel) return DagNodeStatus.Cancelled;
  if (transition.type === DagTransitionType.Complete) return transition.result._tag;
  return undefined;
}

export function requireAttemptFor(
  transition: DagTransition<unknown, unknown>,
  wasRunning: boolean,
  attempt: DagSessionAttemptStatus | undefined,
  attempts: Map<string, DagSessionAttempt>,
  runId: string,
): void {
  const expected =
    transition.type === DagTransitionType.Cancel && !wasRunning
      ? undefined
      : terminalStatus(transition);
  if (!expected) {
    if (attempt)
      throw new DagSessionAttemptInconsistent({
        message: "unexpected attempt status",
        nodeId: transition.nodeId,
      });
    return;
  }
  if (!attempt)
    throw new DagSessionAttemptInconsistent({
      message: "missing attempt status",
      nodeId: transition.nodeId,
    });
  if (attempt.nodeId !== transition.nodeId)
    throw new DagSessionAttemptInconsistent({
      message: "attempt node does not match transition",
      nodeId: attempt.nodeId,
    });
  recordAttempt(attempts, attempt, expected, runId);
}

export function applyTransition(
  graph: ValidatedDagDefinition<unknown>,
  state: DagRunState<unknown, unknown>,
  transition: DagTransition<unknown, unknown>,
) {
  if (transition.runId !== graph.runId)
    throw new DagSessionRunMismatch({ expectedRunId: graph.runId, actualRunId: transition.runId });
  const result = reduceDagRunState(graph, state, transition);
  if (result._tag === DagTransitionResultTag.Rejected)
    throw new DagSessionReducerIllegal({ transition, error: result.error });
  return result;
}

function ensureTransitionCapacity(transitions: readonly unknown[], limits: DagSessionLimits): void {
  if (transitions.length >= limits.transitions)
    throw new DagSessionLimitExceeded({
      limit: "transitions",
      actual: transitions.length + 1,
      max: limits.transitions,
    });
}

function projectProcessLoss(
  graph: ValidatedDagDefinition<unknown>,
  state0: DagRunState<unknown, unknown>,
  transitions: DagTransition<unknown, unknown>[],
  attempts: Map<string, DagSessionAttempt>,
  limits: DagSessionLimits,
): DagRunState<unknown, unknown> {
  let state = state0;
  for (const node of state.nodes)
    if (node.status === DagNodeStatus.Running) {
      ensureTransitionCapacity(transitions, limits);
      const t = {
        runId: graph.runId,
        nodeId: node.nodeId,
        type: DagTransitionType.Complete,
        result: { _tag: DagNodeResultTag.Interrupted, reason: DagSessionProcessLossReason },
      } as const;
      const applied = applyTransition(graph, state, t);
      state = applied.state;
      transitions.push(applied.transition);
      recordAttempt(
        attempts,
        {
          nodeId: node.nodeId,
          attemptId: `${graph.runId}:${node.nodeId}:1`,
          ordinal: 1,
          status: DagNodeStatus.Interrupted,
        },
        DagNodeStatus.Interrupted,
        graph.runId,
      );
    }
  for (;;) {
    const step = deriveDagSchedulingStep(graph, state);
    if (step.transitions.length === 0) break;
    for (const transition of step.transitions) ensureTransitionCapacity(transitions, limits);
    state = step.state;
    transitions.push(...step.transitions);
  }
  for (const node of state.nodes)
    if (node.status === DagNodeStatus.Queued) {
      ensureTransitionCapacity(transitions, limits);
      const t = {
        runId: graph.runId,
        nodeId: node.nodeId,
        type: DagTransitionType.Cancel,
        reason: DagSessionProcessLossReason,
      } as const;
      const applied = applyTransition(graph, state, t);
      state = applied.state;
      transitions.push(applied.transition);
    }
  return state;
}

function selectRequestedEntries(
  decoded: readonly DagSessionEntry[],
  requestedRunId: string,
  options: { readonly expectedGraphId?: string } | undefined,
): readonly DagSessionEntry[] {
  const entries: DagSessionEntry[] = [];
  let mismatchedGraphId: string | undefined;
  for (const entry of decoded) {
    if (entry.runId !== requestedRunId) continue;
    entries.push(entry);
    if (options?.expectedGraphId && entry.graphId !== options.expectedGraphId)
      mismatchedGraphId ??= entry.graphId;
  }
  if (entries.length === 0) throw new DagSessionRunNotFound({ runId: requestedRunId });
  if (options?.expectedGraphId && mismatchedGraphId)
    throw new DagSessionGraphMismatch({
      expectedGraphId: options.expectedGraphId,
      actualGraphId: mismatchedGraphId,
    });
  const expectedGraphId = entries[0]?.graphId ?? "";
  const mismatch = entries.find((entry) => entry.graphId !== expectedGraphId);
  if (mismatch)
    throw new DagSessionGraphMismatch({ expectedGraphId, actualGraphId: mismatch.graphId });
  return entries;
}

function validateEntryOrder(entries: readonly DagSessionEntry[]): void {
  for (let i = 1; i < entries.length; i++)
    if (entries[i]!.seq <= entries[i - 1]!.seq)
      throw entries[i]!.seq === entries[i - 1]!.seq
        ? new DagSessionDuplicate({ seq: entries[i]!.seq })
        : new DagSessionOrdering({ message: "sequence decreased", seq: entries[i]!.seq });
  entries.forEach((entry, index) => {
    if (entry.seq !== index)
      throw new DagSessionTruncated({ expectedSeq: index, actualSeq: entry.seq });
  });
}

type DagSessionGraphEntry = DagSessionEntry & {
  readonly event: Extract<DagSessionEvent, { readonly _tag: "graph" }>;
};

function selectGraphEntry(entries: readonly DagSessionEntry[]): DagSessionGraphEntry {
  let graphEntry: DagSessionGraphEntry | undefined;
  for (const entry of entries) {
    if (entry.event._tag !== "graph") continue;
    if (graphEntry || entry.seq !== 0)
      throw new DagSessionOrdering({ message: "sequence 0 must be exactly one graph entry" });
    graphEntry = entry as DagSessionGraphEntry;
  }
  if (!graphEntry)
    throw new DagSessionOrdering({ message: "sequence 0 must be exactly one graph entry" });
  return graphEntry;
}

function replaySession(
  graph: ValidatedDagDefinition<unknown>,
  entries: readonly DagSessionEntry[],
  limits: DagSessionLimits,
) {
  let state: DagRunState<unknown, unknown> = createDagRunState(graph);
  const transitions: DagTransition<unknown, unknown>[] = [];
  const attempts = new Map<string, DagSessionAttempt>();
  let final;
  for (const entry of entries.slice(1)) {
    if (final) throw new DagSessionOrdering({ message: "final must be last", seq: entry.seq });
    const event = entry.event;
    if (event._tag === "final") {
      final = event.outcome;
      continue;
    }
    if (event._tag !== "transition")
      throw new DagSessionMalformed({ message: "unknown event variant", entry });
    ensureTransitionCapacity(transitions, limits);
    const wasRunning = state.nodes.some(
      (node) => node.nodeId === event.transition.nodeId && node.status === DagNodeStatus.Running,
    );
    const applied = applyTransition(graph, state, event.transition);
    requireAttemptFor(applied.transition, wasRunning, event.attempt, attempts, graph.runId);
    state = applied.state;
    transitions.push(applied.transition);
  }
  return { state, transitions, attempts, final };
}

function finalizeReplayedSession(
  graph: ValidatedDagDefinition<unknown>,
  replayed: ReturnType<typeof replaySession>,
  limits: DagSessionLimits,
) {
  let { state, transitions, attempts, final } = replayed;
  let recoveredFromProcessLoss = false;
  if (!final) {
    recoveredFromProcessLoss = true;
    state = projectProcessLoss(graph, state, transitions, attempts, limits);
  }
  const outcome = deriveDagRunOutcome(graph, state);
  if (outcome._tag !== DagRunOutcomeResultTag.Terminal)
    throw new DagSessionFinalInconsistent({ message: "history is not terminal" });
  if (final && final !== outcome.outcome)
    throw new DagSessionFinalInconsistent({ message: "final outcome does not match state" });
  return { state, transitions, attempts, outcome: outcome.outcome, recoveredFromProcessLoss };
}

function getBranch(seam: DagSessionManagerSeam): readonly unknown[] {
  try {
    return seam.getBranch();
  } catch (cause) {
    throw new DagSessionSeamFailed({ operation: "getBranch", cause });
  }
}

export function reconstructDagSession(
  seam: DagSessionManagerSeam,
  requestedRunId: string,
  options?: { readonly expectedGraphId?: string; readonly limits?: Partial<DagSessionLimits> },
): Effect.Effect<DagSessionReconstruction, DagSessionFailure> {
  return Effect.try({
    try: () => {
      const limits = validateLimits(options?.limits);
      const matchingEntries = getBranch(seam).filter(
        (entry) =>
          isRecord(entry) && entry.type === "custom" && entry.customType === DagSessionEntryType,
      );
      if (matchingEntries.length > limits.totalMatchingEntries)
        throw new DagSessionLimitExceeded({
          limit: "totalMatchingEntries",
          actual: matchingEntries.length,
          max: limits.totalMatchingEntries,
        });
      const decoded = matchingEntries
        .map((entry) => decodeEntry(entry, limits))
        .filter((entry): entry is DagSessionEntry => entry !== undefined);
      const entries = selectRequestedEntries(decoded, requestedRunId, options);
      validateEntryOrder(entries);
      const graphEntry = selectGraphEntry(entries);
      const graph = validateGraph(graphEntry.event.graph, graphEntry.graphId, limits);
      if (graph.runId !== requestedRunId)
        throw new DagSessionRunMismatch({
          expectedRunId: requestedRunId,
          actualRunId: graph.runId,
        });
      const replayed = replaySession(graph, entries, limits);
      const finalized = finalizeReplayedSession(graph, replayed, limits);
      return deepFreeze({
        graph,
        graphId: graphEntry.graphId,
        state: finalized.state,
        terminalOutcome: finalized.outcome,
        transitions: Object.freeze(finalized.transitions),
        attempts: Object.freeze([...finalized.attempts.values()]),
        persistedEntryCount: entries.length,
        recoveredFromProcessLoss: finalized.recoveredFromProcessLoss,
      });
    },
    catch: toSessionFailure,
  });
}
