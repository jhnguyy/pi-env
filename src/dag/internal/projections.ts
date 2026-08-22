import {
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionType,
  type DagNamedOutputs,
  type DagNodeState,
  type DagRunOutcome as DagRunOutcomeValue,
  type DagTransition,
} from "../contracts.js";
import { classifyQueuedNode, QueuedNodeClassification, terminal } from "./readiness.js";
import type { DagRunState} from "./run-state.js";
import { assertMatchingState, getRunningCount, makeRunState } from "./run-state.js";
import { canonicalTransition, nodeStateFromTransition } from "./transitions.js";
import { getDagGraphIndex, type ValidatedDagDefinition } from "./validated-graph.js";

export const DagRunOutcomeResultTag = {
  NonTerminal: "non-terminal",
  Terminal: "terminal",
} as const;
export type DagRunOutcomeResultTag =
  (typeof DagRunOutcomeResultTag)[keyof typeof DagRunOutcomeResultTag];

export interface DagSchedulingStep<TOutputReference = unknown, TFailure = unknown> {
  readonly state: DagRunState<TOutputReference, TFailure>;
  readonly transitions: readonly DagTransition<TOutputReference, TFailure>[];
  readonly readyNodeIds: readonly string[];
}

export type DagRunOutcomeResult =
  | {
      readonly _tag: typeof DagRunOutcomeResultTag.NonTerminal;
      readonly nodeIds: readonly string[];
    }
  | {
      readonly _tag: typeof DagRunOutcomeResultTag.Terminal;
      readonly outcome: DagRunOutcomeValue;
    };

export function deriveDagSchedulingStep<TPayload, TOutputReference = unknown, TFailure = unknown>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TOutputReference, TFailure>,
): DagSchedulingStep<TOutputReference, TFailure> {
  assertMatchingState(graph, state);
  const index = getDagGraphIndex(graph);
  const runningCount = getRunningCount(state);
  let nodes: readonly DagNodeState<TOutputReference, TFailure>[] = state.nodes;
  let copiedNodes: DagNodeState<TOutputReference, TFailure>[] | undefined;
  const transitions: DagTransition<TOutputReference, TFailure>[] = [];
  const readyMask = new Uint8Array(nodes.length);

  for (const nodeIndex of index.topologicalOrder) {
    if (nodes[nodeIndex]?.status !== DagNodeStatus.Queued) continue;
    const classification = classifyQueuedNode(index, nodes, nodeIndex);
    if (classification.kind === QueuedNodeClassification.Ready) {
      readyMask[nodeIndex] = 1;
      continue;
    }
    if (classification.kind !== QueuedNodeClassification.Blocked) continue;

    const transition = canonicalTransition<TOutputReference, TFailure>({
      runId: graph.runId,
      nodeId: index.nodes[nodeIndex]?.id ?? "",
      type: DagTransitionType.Block,
      reason: classification.reason,
      blockedBy: classification.blockedBy,
    });
    copiedNodes ??= [...nodes];
    copiedNodes[nodeIndex] = nodeStateFromTransition(transition);
    nodes = copiedNodes;
    transitions.push(transition);
  }

  const nextState = copiedNodes ? makeRunState(graph, copiedNodes, runningCount) : state;
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
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TOutputReference, TFailure>,
): DagRunOutcomeResult {
  assertMatchingState(graph, state);
  const pending = state.nodes.filter((node) => !terminal(node.status)).map((node) => node.nodeId);
  if (pending.length > 0) {
    return { _tag: DagRunOutcomeResultTag.NonTerminal, nodeIds: Object.freeze(pending) };
  }
  const statuses = state.nodes.map((node) => node.status);
  if (
    statuses.some((status) => status === DagNodeStatus.Failed || status === DagNodeStatus.Blocked)
  ) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagRunOutcome.Failed };
  }
  if (statuses.includes(DagNodeStatus.Interrupted)) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagRunOutcome.Interrupted };
  }
  if (statuses.includes(DagNodeStatus.Cancelled)) {
    return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagRunOutcome.Cancelled };
  }
  return { _tag: DagRunOutcomeResultTag.Terminal, outcome: DagRunOutcome.Succeeded };
}

export function getDagNodeState<TPayload, TOutputReference, TFailure>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TOutputReference, TFailure>,
  nodeId: string,
): DagNodeState<TOutputReference, TFailure> | undefined {
  assertMatchingState(graph, state);
  const nodeIndex = getDagGraphIndex(graph).nodeById.get(nodeId);
  return nodeIndex === undefined ? undefined : state.nodes[nodeIndex];
}

export function getDagOutputReference<TPayload, TOutputReference, TFailure>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TOutputReference, TFailure>,
  nodeId: string,
  outputName: string,
): TOutputReference | undefined {
  const node = getDagNodeState(graph, state, nodeId);
  if (node?.status !== DagNodeStatus.Succeeded) return undefined;
  const outputs: DagNamedOutputs<TOutputReference> = node.outputs;
  return Object.hasOwn(outputs, outputName) ? outputs[outputName] : undefined;
}
