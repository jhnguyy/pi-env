import * as DagContracts from "../contracts.js";
import * as Readiness from "./readiness.js";
import * as RunState from "./run-state.js";
import * as Transitions from "./transitions.js";
import * as ValidatedGraph from "./validated-graph.js";

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
      readonly from: DagContracts.DagNodeStatus;
      readonly to: DagContracts.DagNodeStatus;
    }
  | {
      readonly _tag: typeof DagTransitionErrorTag.InvalidBlock;
      readonly nodeId: string;
      readonly reason: DagContracts.DagBlockedReason;
      readonly blockedBy: readonly string[];
    };

export type DagTransitionResult<TOutputReference = unknown, TFailure = unknown> =
  | {
      readonly _tag: typeof DagTransitionResultTag.Applied;
      readonly state: RunState.DagRunState<TOutputReference, TFailure>;
      readonly transition: DagContracts.DagTransition<TOutputReference, TFailure>;
    }
  | {
      readonly _tag: typeof DagTransitionResultTag.Rejected;
      readonly error: DagTransitionError;
    };

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function transitionIsLegal<TPayload, TOutputReference, TFailure>(
  graph: ValidatedGraph.ValidatedDagDefinition<TPayload>,
  index: ValidatedGraph.DagGraphIndex<TPayload>,
  state: RunState.DagRunState<TOutputReference, TFailure>,
  nodeIndex: number,
  transition: DagContracts.DagTransition<TOutputReference, TFailure>,
): boolean {
  const current = state.nodes[nodeIndex];
  if (!current) return false;
  switch (transition.type) {
    case DagContracts.DagTransitionType.Start:
      return (
        RunState.getRunningCount(state) < graph.concurrency &&
        Readiness.classifyQueuedNode(index, state.nodes, nodeIndex).kind === Readiness.QueuedNodeClassification.Ready
      );
    case DagContracts.DagTransitionType.Complete:
      return current.status === DagContracts.DagNodeStatus.Running;
    case DagContracts.DagTransitionType.Cancel:
      return current.status === DagContracts.DagNodeStatus.Queued || current.status === DagContracts.DagNodeStatus.Running;
    case DagContracts.DagTransitionType.Block: {
      const classification = Readiness.classifyQueuedNode(index, state.nodes, nodeIndex);
      return (
        classification.kind === Readiness.QueuedNodeClassification.Blocked &&
        classification.reason === transition.reason &&
        equalIds(classification.blockedBy, transition.blockedBy)
      );
    }
  }
}

export function reduceDagRunState<TPayload, TOutputReference = unknown, TFailure = unknown>(
  graph: ValidatedGraph.ValidatedDagDefinition<TPayload>,
  state: RunState.DagRunState<TOutputReference, TFailure>,
  transition: DagContracts.DagTransition<TOutputReference, TFailure>,
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
  const index = ValidatedGraph.getDagGraphIndex(graph);
  const nodeIndex = index.nodeById.get(transition.nodeId);
  if (nodeIndex === undefined) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.UnknownNode, nodeId: transition.nodeId },
    };
  }
  const current = state.nodes[nodeIndex];
  if (transition.type === DagContracts.DagTransitionType.Complete && !Transitions.validResultShape(transition.result)) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.MalformedTransition, nodeId: transition.nodeId },
    };
  }
  if (!current || !transitionIsLegal(graph, index, state, nodeIndex, transition)) {
    return {
      _tag: DagTransitionResultTag.Rejected,
      error:
        transition.type === DagContracts.DagTransitionType.Block
          ? {
              _tag: DagTransitionErrorTag.InvalidBlock,
              nodeId: transition.nodeId,
              reason: transition.reason,
              blockedBy: transition.blockedBy,
            }
          : {
              _tag: DagTransitionErrorTag.InvalidTransition,
              nodeId: transition.nodeId,
              from: current?.status ?? DagContracts.DagNodeStatus.Queued,
              to: Transitions.transitionTargetStatus(transition),
            },
    };
  }

  const accepted = Transitions.canonicalTransition(transition);
  const nodes = [...state.nodes];
  nodes[nodeIndex] = Transitions.nodeStateFromTransition(accepted);
  const runningDelta =
    accepted.type === DagContracts.DagTransitionType.Start
      ? 1
      : current.status === DagContracts.DagNodeStatus.Running
        ? -1
        : 0;
  return {
    _tag: DagTransitionResultTag.Applied,
    state: RunState.makeRunState(graph, nodes, RunState.getRunningCount(state) + runningDelta),
    transition: accepted,
  };
}
