import { Effect } from "effect";
import * as DagContracts from "../contracts.js";
import * as DagKernel from "../kernel.js";
import type * as DagValidation from "../validation.js";
import * as SessionCodec from "./codec.js";
import * as SessionContracts from "./contracts.js";

export function applyTransition(
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  state: DagKernel.DagRunState<unknown, unknown>,
  transition: DagContracts.DagTransition<unknown, unknown>,
) {
  if (transition.runId !== graph.runId)
    throw new SessionContracts.DagSessionRunMismatch({ expectedRunId: graph.runId, actualRunId: transition.runId });
  const result = DagKernel.reduceDagRunState(graph, state, transition);
  if (result._tag === DagKernel.DagTransitionResultTag.Rejected)
    throw new SessionContracts.DagSessionReducerIllegal({ transition, error: result.error });
  return result;
}

function ensureTransitionCapacity(transitions: readonly unknown[], limits: SessionContracts.DagSessionLimits): void {
  if (transitions.length >= limits.transitions)
    throw new SessionContracts.DagSessionLimitExceeded({
      limit: "transitions",
      actual: transitions.length + 1,
      max: limits.transitions,
    });
}

function projectProcessLoss(
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  state0: DagKernel.DagRunState<unknown, unknown>,
  transitions: DagContracts.DagTransition<unknown, unknown>[],
  attempts: Map<string, SessionContracts.DagSessionAttempt>,
  limits: SessionContracts.DagSessionLimits,
): DagKernel.DagRunState<unknown, unknown> {
  let state = state0;
  for (const node of state.nodes)
    if (node.status === DagContracts.DagNodeStatus.Running) {
      ensureTransitionCapacity(transitions, limits);
      const t = {
        runId: graph.runId,
        nodeId: node.nodeId,
        type: DagContracts.DagTransitionType.Complete,
        result: { _tag: DagContracts.DagNodeResultTag.Interrupted, reason: SessionContracts.DagSessionProcessLossReason },
      } as const;
      const applied = applyTransition(graph, state, t);
      state = applied.state;
      transitions.push(applied.transition);
      const attemptUpdate = SessionCodec.computeTransitionAttemptUpdate(
        applied.transition,
        true,
        {
          nodeId: node.nodeId,
          attemptId: `${graph.runId}:${node.nodeId}:1`,
          ordinal: 1,
          status: DagContracts.DagNodeStatus.Interrupted,
        },
        attempts.get(node.nodeId),
        graph.runId,
      );
      if (attemptUpdate) attempts.set(attemptUpdate.nodeId, attemptUpdate);
    }
  for (;;) {
    const step = DagKernel.deriveDagSchedulingStep(graph, state);
    if (step.transitions.length === 0) break;
    for (const transition of step.transitions) ensureTransitionCapacity(transitions, limits);
    state = step.state;
    transitions.push(...step.transitions);
  }
  for (const node of state.nodes)
    if (node.status === DagContracts.DagNodeStatus.Queued) {
      ensureTransitionCapacity(transitions, limits);
      const t = {
        runId: graph.runId,
        nodeId: node.nodeId,
        type: DagContracts.DagTransitionType.Cancel,
        reason: SessionContracts.DagSessionProcessLossReason,
      } as const;
      const applied = applyTransition(graph, state, t);
      state = applied.state;
      transitions.push(applied.transition);
    }
  return state;
}

function selectRequestedEntries(
  decoded: readonly SessionContracts.DagSessionEntry[],
  requestedRunId: string,
  options: { readonly expectedGraphId?: string } | undefined,
): readonly SessionContracts.DagSessionEntry[] {
  const entries: SessionContracts.DagSessionEntry[] = [];
  let mismatchedGraphId: string | undefined;
  for (const entry of decoded) {
    if (entry.runId !== requestedRunId) continue;
    entries.push(entry);
    if (options?.expectedGraphId && entry.graphId !== options.expectedGraphId)
      mismatchedGraphId ??= entry.graphId;
  }
  if (entries.length === 0) throw new SessionContracts.DagSessionRunNotFound({ runId: requestedRunId });
  if (options?.expectedGraphId && mismatchedGraphId)
    throw new SessionContracts.DagSessionGraphMismatch({
      expectedGraphId: options.expectedGraphId,
      actualGraphId: mismatchedGraphId,
    });
  const expectedGraphId = entries[0]?.graphId ?? "";
  const mismatch = entries.find((entry) => entry.graphId !== expectedGraphId);
  if (mismatch)
    throw new SessionContracts.DagSessionGraphMismatch({ expectedGraphId, actualGraphId: mismatch.graphId });
  return entries;
}

function validateEntryOrder(entries: readonly SessionContracts.DagSessionEntry[]): void {
  for (let i = 1; i < entries.length; i++)
    if (entries[i].seq <= entries[i - 1].seq)
      throw entries[i].seq === entries[i - 1].seq
        ? new SessionContracts.DagSessionDuplicate({ seq: entries[i].seq })
        : new SessionContracts.DagSessionOrdering({ message: "sequence decreased", seq: entries[i].seq });
  entries.forEach((entry, index) => {
    if (entry.seq !== index)
      throw new SessionContracts.DagSessionTruncated({ expectedSeq: index, actualSeq: entry.seq });
  });
}

type DagSessionGraphEntry = SessionContracts.DagSessionEntry & {
  readonly event: Extract<SessionContracts.DagSessionEvent, { readonly _tag: "graph" }>;
};

function selectGraphEntry(entries: readonly SessionContracts.DagSessionEntry[]): DagSessionGraphEntry {
  let graphEntry: DagSessionGraphEntry | undefined;
  for (const entry of entries) {
    if (entry.event._tag !== "graph") continue;
    if (graphEntry || entry.seq !== 0)
      throw new SessionContracts.DagSessionOrdering({ message: "sequence 0 must be exactly one graph entry" });
    graphEntry = entry as DagSessionGraphEntry;
  }
  if (!graphEntry)
    throw new SessionContracts.DagSessionOrdering({ message: "sequence 0 must be exactly one graph entry" });
  return graphEntry;
}

function replaySession(
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  entries: readonly SessionContracts.DagSessionEntry[],
  limits: SessionContracts.DagSessionLimits,
) {
  let state: DagKernel.DagRunState<unknown, unknown> = DagKernel.createDagRunState(graph);
  const transitions: DagContracts.DagTransition<unknown, unknown>[] = [];
  const attempts = new Map<string, SessionContracts.DagSessionAttempt>();
  let final;
  for (const entry of entries.slice(1)) {
    if (final) throw new SessionContracts.DagSessionOrdering({ message: "final must be last", seq: entry.seq });
    const event = entry.event;
    if (event._tag === "final") {
      final = event.outcome;
      continue;
    }
    if (event._tag !== "transition")
      throw new SessionContracts.DagSessionMalformed({ message: "unknown event variant", entry });
    ensureTransitionCapacity(transitions, limits);
    const wasRunning = state.nodes.some(
      (node) => node.nodeId === event.transition.nodeId && node.status === DagContracts.DagNodeStatus.Running,
    );
    const applied = applyTransition(graph, state, event.transition);
    const attemptUpdate = SessionCodec.computeTransitionAttemptUpdate(
      applied.transition,
      wasRunning,
      event.attempt,
      attempts.get(applied.transition.nodeId),
      graph.runId,
    );
    if (attemptUpdate) attempts.set(attemptUpdate.nodeId, attemptUpdate);
    state = applied.state;
    transitions.push(applied.transition);
  }
  return { state, transitions, attempts, final };
}

function finalizeReplayedSession(
  graph: DagValidation.ValidatedDagDefinition<unknown>,
  replayed: ReturnType<typeof replaySession>,
  limits: SessionContracts.DagSessionLimits,
) {
  let { state, transitions, attempts, final } = replayed;
  let recoveredFromProcessLoss = false;
  if (!final) {
    recoveredFromProcessLoss = true;
    state = projectProcessLoss(graph, state, transitions, attempts, limits);
  }
  const outcome = DagKernel.deriveDagRunOutcome(graph, state);
  if (outcome._tag !== DagKernel.DagRunOutcomeResultTag.Terminal)
    throw new SessionContracts.DagSessionFinalInconsistent({ message: "history is not terminal" });
  if (final && final !== outcome.outcome)
    throw new SessionContracts.DagSessionFinalInconsistent({ message: "final outcome does not match state" });
  return { state, transitions, attempts, outcome: outcome.outcome, recoveredFromProcessLoss };
}

function getBranch(seam: SessionContracts.DagSessionManagerSeam): readonly unknown[] {
  try {
    return seam.getBranch();
  } catch (cause) {
    throw new SessionContracts.DagSessionSeamFailed({ operation: "getBranch", cause });
  }
}

export function reconstructDagSession(
  seam: SessionContracts.DagSessionManagerSeam,
  requestedRunId: string,
  options?: { readonly expectedGraphId?: string; readonly limits?: Partial<SessionContracts.DagSessionLimits> },
): Effect.Effect<SessionContracts.DagSessionReconstruction, SessionContracts.DagSessionFailure> {
  return Effect.try({
    try: () => {
      const limits = SessionCodec.validateLimits(options?.limits);
      const matchingEntries = getBranch(seam).filter(
        (entry) =>
          SessionCodec.isRecord(entry) && entry.type === "custom" && entry.customType === SessionContracts.DagSessionEntryType,
      );
      if (matchingEntries.length > limits.totalMatchingEntries)
        throw new SessionContracts.DagSessionLimitExceeded({
          limit: "totalMatchingEntries",
          actual: matchingEntries.length,
          max: limits.totalMatchingEntries,
        });
      const decoded = matchingEntries
        .map((entry) => SessionCodec.decodeEntry(entry, limits))
        .filter((entry): entry is SessionContracts.DagSessionEntry => entry !== undefined);
      const entries = selectRequestedEntries(decoded, requestedRunId, options);
      validateEntryOrder(entries);
      const graphEntry = selectGraphEntry(entries);
      const graph = SessionCodec.validateGraph(graphEntry.event.graph, graphEntry.graphId, limits);
      if (graph.runId !== requestedRunId)
        throw new SessionContracts.DagSessionRunMismatch({
          expectedRunId: requestedRunId,
          actualRunId: graph.runId,
        });
      const replayed = replaySession(graph, entries, limits);
      const finalized = finalizeReplayedSession(graph, replayed, limits);
      return SessionCodec.deepFreeze({
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
    catch: SessionContracts.toSessionFailure,
  });
}
