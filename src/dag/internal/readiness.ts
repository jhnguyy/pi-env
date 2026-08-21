import {
  DagBlockedReason,
  DagDependencyMode,
  DagNodeStatus,
  type DagNodeState,
} from "../contracts.js";
import type { DagGraphIndex } from "./validated-graph.js";

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
      readonly reason: DagBlockedReason;
      readonly blockedBy: readonly string[];
    };

const ready = Object.freeze({ kind: QueuedNodeClassification.Ready });
const waiting = Object.freeze({ kind: QueuedNodeClassification.Waiting });

export function terminal(status: DagNodeStatus): boolean {
  return (
    status === DagNodeStatus.Succeeded ||
    status === DagNodeStatus.Failed ||
    status === DagNodeStatus.Blocked ||
    status === DagNodeStatus.Cancelled ||
    status === DagNodeStatus.Interrupted
  );
}

function classifyDependencies<TPayload, TOutputReference, TFailure>(
  index: DagGraphIndex<TPayload>,
  states: readonly DagNodeState<TOutputReference, TFailure>[],
  nodeIndex: number,
): QueuedNodeClassification {
  let failedRequired: string[] | undefined;
  let hasWaitingDependency = false;
  for (const dependency of index.dependencies[nodeIndex] ?? []) {
    const status = states[dependency.index]?.status;
    if (dependency.mode === DagDependencyMode.Settled) {
      if (status === undefined || !terminal(status)) hasWaitingDependency = true;
      continue;
    }
    if (status === DagNodeStatus.Succeeded) continue;
    if (status !== undefined && terminal(status)) {
      (failedRequired ??= []).push(index.nodes[dependency.index]?.id ?? "");
    } else hasWaitingDependency = true;
  }
  if (failedRequired) {
    return {
      kind: QueuedNodeClassification.Blocked,
      reason: DagBlockedReason.RequiredDependency,
      blockedBy: failedRequired,
    };
  }
  return hasWaitingDependency ? waiting : ready;
}

export function classifyQueuedNode<TPayload, TOutputReference, TFailure>(
  index: DagGraphIndex<TPayload>,
  states: readonly DagNodeState<TOutputReference, TFailure>[],
  nodeIndex: number,
): QueuedNodeClassification {
  if (states[nodeIndex]?.status !== DagNodeStatus.Queued) {
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
      (dependencyIndex) => states[dependencyIndex]?.status === DagNodeStatus.Succeeded,
    )
  ) {
    return {
      kind: QueuedNodeClassification.Blocked,
      reason: DagBlockedReason.CompletionGuard,
      blockedBy: guardIndices.map((dependencyIndex) => index.nodes[dependencyIndex]?.id ?? ""),
    };
  }
  return ready;
}
