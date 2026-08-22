import * as DagContracts from "../contracts.js";
import type * as ValidatedGraph from "./validated-graph.js";

export const QueuedNodeClassification = {
  Ready: "ready",
  Waiting: "waiting",
  Blocked: "blocked",
} as const;

export type QueuedNodeClassification =
  | { readonly kind: typeof QueuedNodeClassification.Ready }
  | { readonly kind: typeof QueuedNodeClassification.Waiting }
  | {
      readonly kind: typeof QueuedNodeClassification.Blocked;
      readonly reason: DagContracts.DagBlockedReason;
      readonly blockedBy: readonly string[];
    };

const ready = Object.freeze({ kind: QueuedNodeClassification.Ready });
const waiting = Object.freeze({ kind: QueuedNodeClassification.Waiting });

export function terminal(status: DagContracts.DagNodeStatus): boolean {
  switch (status) {
    case DagContracts.DagNodeStatus.Succeeded:
    case DagContracts.DagNodeStatus.Failed:
    case DagContracts.DagNodeStatus.Blocked:
    case DagContracts.DagNodeStatus.Cancelled:
    case DagContracts.DagNodeStatus.Interrupted:
      return true;
    default:
      return false;
  }
}

function classifyDependencies<TPayload, TOutputReference, TFailure>(
  index: ValidatedGraph.DagGraphIndex<TPayload>,
  states: readonly DagContracts.DagNodeState<TOutputReference, TFailure>[],
  nodeIndex: number,
): QueuedNodeClassification {
  let failedRequired: string[] | undefined;
  let hasWaitingDependency = false;
  for (const dependency of index.dependencies[nodeIndex] ?? []) {
    const status = states[dependency.index]?.status;
    if (dependency.mode === DagContracts.DagDependencyMode.Settled) {
      if (status === undefined || !terminal(status)) hasWaitingDependency = true;
      continue;
    }
    if (status === DagContracts.DagNodeStatus.Succeeded) continue;
    if (status !== undefined && terminal(status)) {
      (failedRequired ??= []).push(index.nodes[dependency.index]?.id ?? "");
    } else hasWaitingDependency = true;
  }
  if (failedRequired) {
    return {
      kind: QueuedNodeClassification.Blocked,
      reason: DagContracts.DagBlockedReason.RequiredDependency,
      blockedBy: failedRequired,
    };
  }
  return hasWaitingDependency ? waiting : ready;
}

export function classifyQueuedNode<TPayload, TOutputReference, TFailure>(
  index: ValidatedGraph.DagGraphIndex<TPayload>,
  states: readonly DagContracts.DagNodeState<TOutputReference, TFailure>[],
  nodeIndex: number,
): QueuedNodeClassification {
  if (states[nodeIndex]?.status !== DagContracts.DagNodeStatus.Queued) {
    return waiting;
  }

  const dependencyClassification = classifyDependencies(index, states, nodeIndex);
  if (dependencyClassification.kind !== QueuedNodeClassification.Ready) {
    return dependencyClassification;
  }

  const guardIndices = index.guardIndices[nodeIndex];
  if (
    guardIndices &&
    !guardIndices.some(
      (dependencyIndex) => states[dependencyIndex]?.status === DagContracts.DagNodeStatus.Succeeded,
    )
  ) {
    return {
      kind: QueuedNodeClassification.Blocked,
      reason: DagContracts.DagBlockedReason.CompletionGuard,
      blockedBy: guardIndices.map((dependencyIndex) => index.nodes[dependencyIndex]?.id ?? ""),
    };
  }
  return ready;
}
