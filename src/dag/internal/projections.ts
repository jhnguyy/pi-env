import * as DagContracts from "../contracts.js";
import * as Readiness from "./readiness.js";
import * as RunState from "./run-state.js";
import * as Transitions from "./transitions.js";
import * as ValidatedGraph from "./validated-graph.js";

export const DagRunOutcomeResultTag = {
  NonTerminal: "non-terminal",
  Terminal: "terminal",
} as const;
export type DagRunOutcomeResultTag =
  (typeof DagRunOutcomeResultTag)[keyof typeof DagRunOutcomeResultTag];

export interface DagSchedulingStep<TOutputReference = unknown, TFailure = unknown> {
  readonly state: RunState.DagRunState<TOutputReference, TFailure>;
  readonly transitions: readonly DagContracts.DagTransition<TOutputReference, TFailure>[];
  readonly readyNodeIds: readonly string[];
}

export type DagRunOutcomeResult =
  | {
      readonly _tag: typeof DagRunOutcomeResultTag.NonTerminal;
      readonly nodeIds: readonly string[];
    }
  | {
      readonly _tag: typeof DagRunOutcomeResultTag.Terminal;
      readonly outcome: DagContracts.DagRunOutcome;
    };

export function deriveDagSchedulingStep<TPayload, TOutputReference = unknown, TFailure = unknown>(
  graph: ValidatedGraph.ValidatedDagDefinition<TPayload>,
  state: RunState.DagRunState<TOutputReference, TFailure>,
): DagSchedulingStep<TOutputReference, TFailure> {
  RunState.assertMatchingState(graph, state);
  const index = ValidatedGraph.getDagGraphIndex(graph);
  const runningCount = RunState.getRunningCount(state);
  let nodes: readonly DagContracts.DagNodeState<TOutputReference, TFailure>[] = state.nodes;
  let copiedNodes: DagContracts.DagNodeState<TOutputReference, TFailure>[] | undefined;
  const transitions: DagContracts.DagTransition<TOutputReference, TFailure>[] = [];
  const readyMask = new Uint8Array(nodes.length);

  for (const nodeIndex of index.topologicalOrder) {
    if (nodes[nodeIndex]?.status !== DagContracts.DagNodeStatus.Queued) continue;
    const classification = Readiness.classifyQueuedNode(index, nodes, nodeIndex);
    if (classification.kind === Readiness.QueuedNodeClassification.Ready) {
      readyMask[nodeIndex] = 1;
      continue;
    }
    if (classification.kind !== Readiness.QueuedNodeClassification.Blocked) continue;

    const transition = Transitions.canonicalTransition<TOutputReference, TFailure>({
      runId: graph.runId,
      nodeId: index.nodes[nodeIndex]?.id ?? "",
      type: DagContracts.DagTransitionType.Block,
      reason: classification.reason,
      blockedBy: classification.blockedBy,
    });
    copiedNodes ??= [...nodes];
    copiedNodes[nodeIndex] = Transitions.nodeStateFromTransition(transition);
    nodes = copiedNodes;
    transitions.push(transition);
  }

  const nextState = copiedNodes ? RunState.makeRunState(graph, copiedNodes, runningCount) : state;
  const available = Math.max(0, graph.concurrency - runningCount);
  const readyNodeIds: string[] = [];
  for (
    let nodeIndex = 0;
    nodeIndex < readyMask.length && readyNodeIds.length < available;
    nodeIndex++
  ) {
    if (readyMask[nodeIndex] === 1) readyNodeIds.push(index.nodes[nodeIndex]?.id ?? "");
  }
  return Object.freeze({
    state: nextState,
    transitions: Object.freeze(transitions),
    readyNodeIds: Object.freeze(readyNodeIds),
  });
}

export function deriveDagRunOutcome<TPayload, TOutputReference, TFailure>(
  graph: ValidatedGraph.ValidatedDagDefinition<TPayload>,
  state: RunState.DagRunState<TOutputReference, TFailure>,
): DagRunOutcomeResult {
  RunState.assertMatchingState(graph, state);
  const pending = state.nodes.filter((node) => !Readiness.terminal(node.status)).map((node) => node.nodeId);
  if (pending.length > 0) {
    return { _tag: DagRunOutcomeResultTag.NonTerminal, nodeIds: Object.freeze(pending) };
  }
  const statuses = state.nodes.map((node) => node.status);
  if (
    statuses.some((status) => status === DagContracts.DagNodeStatus.Failed || status === DagContracts.DagNodeStatus.Blocked)
  ) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagContracts.DagRunOutcome.Failed };
  }
  if (statuses.includes(DagContracts.DagNodeStatus.Interrupted)) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagContracts.DagRunOutcome.Interrupted };
  }
  if (statuses.includes(DagContracts.DagNodeStatus.Cancelled)) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagContracts.DagRunOutcome.Cancelled };
  }
  return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagContracts.DagRunOutcome.Succeeded };
}

export function getDagNodeState<TPayload, TOutputReference, TFailure>(
  graph: ValidatedGraph.ValidatedDagDefinition<TPayload>,
  state: RunState.DagRunState<TOutputReference, TFailure>,
  nodeId: string,
): DagContracts.DagNodeState<TOutputReference, TFailure> | undefined {
  RunState.assertMatchingState(graph, state);
  const nodeIndex = ValidatedGraph.getDagGraphIndex(graph).nodeById.get(nodeId);
  return nodeIndex === undefined ? undefined : state.nodes[nodeIndex];
}

export function getDagOutputReference<TPayload, TOutputReference, TFailure>(
  graph: ValidatedGraph.ValidatedDagDefinition<TPayload>,
  state: RunState.DagRunState<TOutputReference, TFailure>,
  nodeId: string,
  outputName: string,
): TOutputReference | undefined {
  const node = getDagNodeState(graph, state, nodeId);
  if (node?.status !== DagContracts.DagNodeStatus.Succeeded) return undefined;
  const outputs: DagContracts.DagNamedOutputs<TOutputReference> = node.outputs;
  return Object.hasOwn(outputs, outputName) ? outputs[outputName] : undefined;
}
