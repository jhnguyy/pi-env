import {
  DagBlockedReason,
  DagDependencyMode,
  DagNodeStatus,
  DagRunOutcome,
  DagRunOutcomeResultTag,
  DagTransitionResultTag,
  DagTransitionType,
  type DagNode,
  type DagOutputReference,
  type DagRunOutcomeResult,
  type DagSchedulingStep,
  type DagTransition,
  type ValidatedDagDefinition,
} from "./types.js";
import {
  canStartDagNode,
  dagRunStateMatchesGraph,
  getDagNodeState,
  isTerminalDagNodeStatus,
  reduceDagRunState,
  type DagRunState,
} from "./state.js";

function blockingTransition<TPayload, TReference extends DagOutputReference>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
  node: DagNode<TPayload>,
): DagTransition<TReference> | undefined {
  const failedRequiredDependencies = node.dependencies
    .filter((dependency) => dependency.mode === DagDependencyMode.Required)
    .filter((dependency) => {
      const dependencyState = getDagNodeState(state, dependency.nodeId);
      return (
        dependencyState !== undefined &&
        isTerminalDagNodeStatus(dependencyState.status) &&
        dependencyState.status !== DagNodeStatus.Succeeded
      );
    })
    .map((dependency) => dependency.nodeId);
  if (failedRequiredDependencies.length > 0) {
    return {
      runId: graph.runId,
      nodeId: node.id,
      type: DagTransitionType.Block,
      reason: DagBlockedReason.RequiredDependency,
      blockedBy: failedRequiredDependencies,
    };
  }

  const guardedDependencyIds = node.completionGuard?.dependencyIds;
  if (!guardedDependencyIds) return undefined;
  const guardedStates = guardedDependencyIds.map((dependencyId) =>
    getDagNodeState(state, dependencyId),
  );
  if (
    guardedStates.every(
      (dependencyState) =>
        dependencyState !== undefined && isTerminalDagNodeStatus(dependencyState.status),
    ) &&
    guardedStates.every((dependencyState) => dependencyState?.status !== DagNodeStatus.Succeeded)
  ) {
    return {
      runId: graph.runId,
      nodeId: node.id,
      type: DagTransitionType.Block,
      reason: DagBlockedReason.CompletionGuard,
      blockedBy: guardedDependencyIds,
    };
  }
  return undefined;
}

export function deriveDagSchedulingStep<
  TPayload,
  TReference extends DagOutputReference = DagOutputReference,
>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
): DagSchedulingStep<TReference> {
  if (!dagRunStateMatchesGraph(graph, state)) {
    return Object.freeze({
      state,
      transitions: Object.freeze([]),
      readyNodeIds: Object.freeze([]),
    });
  }
  let current = state;
  const transitions: DagTransition<TReference>[] = [];
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (getDagNodeState(current, node.id)?.status !== DagNodeStatus.Queued) continue;
      const transition = blockingTransition(graph, current, node);
      if (!transition) continue;
      const result = reduceDagRunState(graph, current, transition);
      if (result._tag !== DagTransitionResultTag.Applied) continue;
      current = result.state;
      transitions.push(result.transition);
      changed = true;
    }
  }

  const runningCount = current.nodes.filter((node) => node.status === DagNodeStatus.Running).length;
  const availableSlots = Math.max(0, graph.concurrency - runningCount);
  const readyNodeIds = graph.nodes
    .filter((node) => canStartDagNode(graph, current, node.id))
    .slice(0, availableSlots)
    .map((node) => node.id);
  return Object.freeze({
    state: current,
    transitions: Object.freeze(transitions),
    readyNodeIds: Object.freeze(readyNodeIds),
  });
}

export function deriveDagRunOutcome<
  TPayload,
  TReference extends DagOutputReference = DagOutputReference,
>(graph: ValidatedDagDefinition<TPayload>, state: DagRunState<TReference>): DagRunOutcomeResult {
  if (!dagRunStateMatchesGraph(graph, state)) {
    return {
      _tag: DagRunOutcomeResultTag.NonTerminal,
      nodeIds: Object.freeze(graph.nodes.map((node) => node.id)),
    };
  }
  const nonTerminalNodeIds = graph.nodes
    .filter((node) => {
      const nodeState = getDagNodeState(state, node.id);
      return !nodeState || !isTerminalDagNodeStatus(nodeState.status);
    })
    .map((node) => node.id);
  if (nonTerminalNodeIds.length > 0) {
    return {
      _tag: DagRunOutcomeResultTag.NonTerminal,
      nodeIds: Object.freeze(nonTerminalNodeIds),
    };
  }

  const statuses = graph.nodes.map((node) => getDagNodeState(state, node.id)?.status);
  if (
    statuses.some((status) => status === DagNodeStatus.Failed || status === DagNodeStatus.Blocked)
  ) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagRunOutcome.Failed };
  }
  if (statuses.includes(DagNodeStatus.Interrupted)) {
    return {
      _tag: DagRunOutcomeResultTag.Terminal,
      outcome: DagRunOutcome.Interrupted,
    };
  }
  if (statuses.includes(DagNodeStatus.Cancelled)) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagRunOutcome.Cancelled };
  }
  return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagRunOutcome.Succeeded };
}
