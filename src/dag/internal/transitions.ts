import * as DagContracts from "../contracts.js";

function freezeOutputs<TOutputReference>(
  outputs: DagContracts.DagNamedOutputs<TOutputReference>,
): DagContracts.DagNamedOutputs<TOutputReference> {
  return Object.freeze(
    Object.fromEntries(Object.entries(outputs)),
  );
}

export function validResultShape(result: unknown): result is DagContracts.DagNodeResult {
  if (typeof result !== "object" || result === null) return false;
  const candidate = result as Record<string, unknown>;
  switch (candidate._tag) {
    case DagContracts.DagNodeResultTag.Succeeded:
      return (
        typeof candidate.outputs === "object" &&
        candidate.outputs !== null &&
        !Array.isArray(candidate.outputs)
      );
    case DagContracts.DagNodeResultTag.Failed:
      return Object.hasOwn(candidate, "failure");
    case DagContracts.DagNodeResultTag.Cancelled:
    case DagContracts.DagNodeResultTag.Interrupted:
      return candidate.reason === undefined || typeof candidate.reason === "string";
    default:
      return false;
  }
}

function canonicalResult<TOutputReference, TFailure>(
  result: DagContracts.DagNodeResult<TOutputReference, TFailure>,
): DagContracts.DagNodeResult<TOutputReference, TFailure> {
  switch (result._tag) {
    case DagContracts.DagNodeResultTag.Succeeded:
      return Object.freeze({ _tag: result._tag, outputs: freezeOutputs(result.outputs) });
    case DagContracts.DagNodeResultTag.Failed:
      return Object.freeze({ _tag: result._tag, failure: result.failure });
    case DagContracts.DagNodeResultTag.Cancelled:
    case DagContracts.DagNodeResultTag.Interrupted:
      return Object.freeze({
        _tag: result._tag,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
  }
}

export function canonicalTransition<TOutputReference, TFailure>(
  transition: DagContracts.DagTransition<TOutputReference, TFailure>,
): DagContracts.DagTransition<TOutputReference, TFailure> {
  switch (transition.type) {
    case DagContracts.DagTransitionType.Start:
      return Object.freeze({
        runId: transition.runId,
        nodeId: transition.nodeId,
        type: transition.type,
      });
    case DagContracts.DagTransitionType.Complete:
      return Object.freeze({
        runId: transition.runId,
        nodeId: transition.nodeId,
        type: transition.type,
        result: canonicalResult(transition.result),
      });
    case DagContracts.DagTransitionType.Block:
      return Object.freeze({
        runId: transition.runId,
        nodeId: transition.nodeId,
        type: transition.type,
        reason: transition.reason,
        blockedBy: Object.freeze([...transition.blockedBy]),
      });
    case DagContracts.DagTransitionType.Cancel:
      return Object.freeze({
        runId: transition.runId,
        nodeId: transition.nodeId,
        type: transition.type,
        ...(transition.reason === undefined ? {} : { reason: transition.reason }),
      });
  }
}

function stateFromResult<TOutputReference, TFailure>(
  nodeId: string,
  result: DagContracts.DagNodeResult<TOutputReference, TFailure>,
): DagContracts.DagNodeState<TOutputReference, TFailure> {
  switch (result._tag) {
    case DagContracts.DagNodeResultTag.Succeeded:
      return Object.freeze({ nodeId, status: DagContracts.DagNodeStatus.Succeeded, outputs: result.outputs });
    case DagContracts.DagNodeResultTag.Failed:
      return Object.freeze({ nodeId, status: DagContracts.DagNodeStatus.Failed, failure: result.failure });
    case DagContracts.DagNodeResultTag.Cancelled:
      return Object.freeze({
        nodeId,
        status: DagContracts.DagNodeStatus.Cancelled,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    case DagContracts.DagNodeResultTag.Interrupted:
      return Object.freeze({
        nodeId,
        status: DagContracts.DagNodeStatus.Interrupted,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
  }
}

export function nodeStateFromTransition<TOutputReference, TFailure>(
  transition: DagContracts.DagTransition<TOutputReference, TFailure>,
): DagContracts.DagNodeState<TOutputReference, TFailure> {
  switch (transition.type) {
    case DagContracts.DagTransitionType.Start:
      return Object.freeze({ nodeId: transition.nodeId, status: DagContracts.DagNodeStatus.Running });
    case DagContracts.DagTransitionType.Complete:
      return stateFromResult(transition.nodeId, transition.result);
    case DagContracts.DagTransitionType.Block:
      return Object.freeze({
        nodeId: transition.nodeId,
        status: DagContracts.DagNodeStatus.Blocked,
        reason: transition.reason,
        blockedBy: transition.blockedBy,
      });
    case DagContracts.DagTransitionType.Cancel:
      return Object.freeze({
        nodeId: transition.nodeId,
        status: DagContracts.DagNodeStatus.Cancelled,
        ...(transition.reason === undefined ? {} : { reason: transition.reason }),
      });
  }
}

export function transitionTargetStatus(transition: DagContracts.DagTransition): DagContracts.DagNodeStatus {
  switch (transition.type) {
    case DagContracts.DagTransitionType.Start:
      return DagContracts.DagNodeStatus.Running;
    case DagContracts.DagTransitionType.Block:
      return DagContracts.DagNodeStatus.Blocked;
    case DagContracts.DagTransitionType.Cancel:
      return DagContracts.DagNodeStatus.Cancelled;
    case DagContracts.DagTransitionType.Complete:
      return transition.result._tag;
  }
}
