import {
  DagNodeStatus,
  DagTransitionType,
  type DagBlockedReason,
  type DagTransition,
} from "../contracts.js";
import { classifyQueuedNode, QueuedNodeClassification } from "./readiness.js";
import type { DagRunState} from "./run-state.js";
import { getRunningCount, makeRunState } from "./run-state.js";
import {
  canonicalTransition,
  nodeStateFromTransition,
  transitionTargetStatus,
  validResultShape,
} from "./transitions.js";
import {
  getDagGraphIndex,
  type DagGraphIndex,
  type ValidatedDagDefinition,
} from "./validated-graph.js";

export const DagTransitionResultTag = {
  Applied: "applied",
  Rejected: "rejected",
} as const;
export type DagTransitionResultTag =
  (typeof DagTransitionResultTag)[keyof typeof DagTransitionResultTag];

export const DagTransitionErrorTag = {
  RunMismatch: "run-mismatch",
  StateMismatch: "state-mismatch",
  UnknownNode: "unknown-node",
  MalformedTransition: "malformed-transition",
  InvalidTransition: "invalid-transition",
  InvalidBlock: "invalid-block",
} as const;
export type DagTransitionErrorTag =
  (typeof DagTransitionErrorTag)[keyof typeof DagTransitionErrorTag];

export type DagTransitionError =
  | {
      readonly _tag: typeof DagTransitionErrorTag.RunMismatch;
      readonly expectedRunId: string;
      readonly actualRunId: string;
    }
  | { readonly _tag: typeof DagTransitionErrorTag.StateMismatch }
  | { readonly _tag: typeof DagTransitionErrorTag.UnknownNode; readonly nodeId: string }
  | { readonly _tag: typeof DagTransitionErrorTag.MalformedTransition; readonly nodeId: string }
  | {
      readonly _tag: typeof DagTransitionErrorTag.InvalidTransition;
      readonly nodeId: string;
      readonly from: DagNodeStatus;
      readonly to: DagNodeStatus;
    }
  | {
      readonly _tag: typeof DagTransitionErrorTag.InvalidBlock;
      readonly nodeId: string;
      readonly reason: DagBlockedReason;
      readonly blockedBy: readonly string[];
    };

export type DagTransitionResult<TOutputReference = unknown, TFailure = unknown> =
  | {
      readonly _tag: typeof DagTransitionResultTag.Applied;
      readonly state: DagRunState<TOutputReference, TFailure>;
      readonly transition: DagTransition<TOutputReference, TFailure>;
    }
  | {
      readonly _tag: typeof DagTransitionResultTag.Rejected;
      readonly error: DagTransitionError;
    };

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function transitionIsLegal<TPayload, TOutputReference, TFailure>(
  graph: ValidatedDagDefinition<TPayload>,
  index: DagGraphIndex<TPayload>,
  state: DagRunState<TOutputReference, TFailure>,
  nodeIndex: number,
  transition: DagTransition<TOutputReference, TFailure>,
): boolean {
  const current = state.nodes[nodeIndex];
  if (!current) return false;
  switch (transition.type) {
    case DagTransitionType.Start:
      return (
        getRunningCount(state) < graph.concurrency &&
        classifyQueuedNode(index, state.nodes, nodeIndex).kind === QueuedNodeClassification.Ready
      );
    case DagTransitionType.Complete:
      return current.status === DagNodeStatus.Running;
    case DagTransitionType.Cancel:
      return current.status === DagNodeStatus.Queued || current.status === DagNodeStatus.Running;
    case DagTransitionType.Block: {
      const classification = classifyQueuedNode(index, state.nodes, nodeIndex);
      return (
        classification.kind === QueuedNodeClassification.Blocked &&
        classification.reason === transition.reason &&
        equalIds(classification.blockedBy, transition.blockedBy)
      );
    }
  }
}

export function reduceDagRunState<TPayload, TOutputReference = unknown, TFailure = unknown>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TOutputReference, TFailure>,
  transition: DagTransition<TOutputReference, TFailure>,
): DagTransitionResult<TOutputReference, TFailure> {
  if (transition.runId !== graph.runId) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error: {
        _tag: DagTransitionErrorTag.RunMismatch,
        expectedRunId: graph.runId,
        actualRunId: transition.runId,
      },
    };
  }
  if (!state.belongsTo(graph)) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.StateMismatch },
    };
  }
  const index = getDagGraphIndex(graph);
  const nodeIndex = index.nodeById.get(transition.nodeId);
  if (nodeIndex === undefined) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.UnknownNode, nodeId: transition.nodeId },
    };
  }
  const current = state.nodes[nodeIndex];
  if (transition.type === DagTransitionType.Complete && !validResultShape(transition.result)) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.MalformedTransition, nodeId: transition.nodeId },
    };
  }
  if (!current || !transitionIsLegal(graph, index, state, nodeIndex, transition)) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error:
        transition.type === DagTransitionType.Block
          ? {
              _tag: DagTransitionErrorTag.InvalidBlock,
              nodeId: transition.nodeId,
              reason: transition.reason,
              blockedBy: transition.blockedBy,
            }
          : {
              _tag: DagTransitionErrorTag.InvalidTransition,
              nodeId: transition.nodeId,
              from: current?.status ?? DagNodeStatus.Queued,
              to: transitionTargetStatus(transition),
            },
    };
  }

  const accepted = canonicalTransition(transition);
  const nodes = [...state.nodes];
  nodes[nodeIndex] = nodeStateFromTransition(accepted);
  const runningDelta =
    accepted.type === DagTransitionType.Start
      ? 1
      : current.status === DagNodeStatus.Running
        ? -1
        : 0;
  return {
    _tag: DagTransitionResultTag.Applied,
    state: makeRunState(graph, nodes, getRunningCount(state) + runningDelta),
    transition: accepted,
  };
}
