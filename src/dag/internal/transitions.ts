import {
  DagNodeResultTag,
  DagNodeStatus,
  DagTransitionType,
  type DagNamedOutputs,
  type DagNodeResult,
  type DagNodeState,
  type DagTransition,
} from "../contracts.js";

function freezeOutputs<TOutputReference>(
  outputs: DagNamedOutputs<TOutputReference>,
): DagNamedOutputs<TOutputReference> {
  return Object.freeze(
    Object.fromEntries(Object.entries(outputs)),
  ) as DagNamedOutputs<TOutputReference>;
}

export function validResultShape(result: unknown): result is DagNodeResult {
  if (typeof result !== "object" || result === null) return false;
  const candidate = result as Record<string, unknown>;
  switch (candidate._tag) {
    case DagNodeResultTag.Succeeded:
      return (
        typeof candidate.outputs === "object" &&
        candidate.outputs !== null &&
        !Array.isArray(candidate.outputs)
      );
    case DagNodeResultTag.Failed:
      return Object.hasOwn(candidate, "failure");
    case DagNodeResultTag.Cancelled:
    case DagNodeResultTag.Interrupted:
      return candidate.reason === undefined || typeof candidate.reason === "string";
    default:
      return false;
  }
}

function canonicalResult<TOutputReference, TFailure>(
  result: DagNodeResult<TOutputReference, TFailure>,
): DagNodeResult<TOutputReference, TFailure> {
  switch (result._tag) {
    case DagNodeResultTag.Succeeded:
      return Object.freeze({ _tag: result._tag, outputs: freezeOutputs(result.outputs) });
    case DagNodeResultTag.Failed:
      return Object.freeze({ _tag: result._tag, failure: result.failure });
    case DagNodeResultTag.Cancelled:
    case DagNodeResultTag.Interrupted:
      return Object.freeze({
        _tag: result._tag,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
  }
}

export function canonicalTransition<TOutputReference, TFailure>(
  transition: DagTransition<TOutputReference, TFailure>,
): DagTransition<TOutputReference, TFailure> {
  switch (transition.type) {
    case DagTransitionType.Start:
      return Object.freeze({
        runId: transition.runId,
        nodeId: transition.nodeId,
        type: transition.type,
      });
    case DagTransitionType.Complete:
      return Object.freeze({
        runId: transition.runId,
        nodeId: transition.nodeId,
        type: transition.type,
        result: canonicalResult(transition.result),
      });
    case DagTransitionType.Block:
      return Object.freeze({
        runId: transition.runId,
        nodeId: transition.nodeId,
        type: transition.type,
        reason: transition.reason,
        blockedBy: Object.freeze([...transition.blockedBy]),
      });
    case DagTransitionType.Cancel:
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
  result: DagNodeResult<TOutputReference, TFailure>,
): DagNodeState<TOutputReference, TFailure> {
  switch (result._tag) {
    case DagNodeResultTag.Succeeded:
      return Object.freeze({ nodeId, status: DagNodeStatus.Succeeded, outputs: result.outputs });
    case DagNodeResultTag.Failed:
      return Object.freeze({ nodeId, status: DagNodeStatus.Failed, failure: result.failure });
    case DagNodeResultTag.Cancelled:
      return Object.freeze({
        nodeId,
        status: DagNodeStatus.Cancelled,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    case DagNodeResultTag.Interrupted:
      return Object.freeze({
        nodeId,
        status: DagNodeStatus.Interrupted,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
  }
}

export function nodeStateFromTransition<TOutputReference, TFailure>(
  transition: DagTransition<TOutputReference, TFailure>,
): DagNodeState<TOutputReference, TFailure> {
  switch (transition.type) {
    case DagTransitionType.Start:
      return Object.freeze({ nodeId: transition.nodeId, status: DagNodeStatus.Running });
    case DagTransitionType.Complete:
      return stateFromResult(transition.nodeId, transition.result);
    case DagTransitionType.Block:
      return Object.freeze({
        nodeId: transition.nodeId,
        status: DagNodeStatus.Blocked,
        reason: transition.reason,
        blockedBy: transition.blockedBy,
      });
    case DagTransitionType.Cancel:
      return Object.freeze({
        nodeId: transition.nodeId,
        status: DagNodeStatus.Cancelled,
        ...(transition.reason === undefined ? {} : { reason: transition.reason }),
      });
  }
}

export function transitionTargetStatus(transition: DagTransition): DagNodeStatus {
  switch (transition.type) {
    case DagTransitionType.Start:
      return DagNodeStatus.Running;
    case DagTransitionType.Block:
      return DagNodeStatus.Blocked;
    case DagTransitionType.Cancel:
      return DagNodeStatus.Cancelled;
    case DagTransitionType.Complete:
      return transition.result._tag;
  }
}
