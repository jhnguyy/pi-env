import {
  DagBlockedReason,
  DagDependencyMode,
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionType,
  type DagNamedOutputs,
  type DagNodeResult,
  type DagNodeState,
  type DagRunOutcome as DagRunOutcomeValue,
  type DagTransition,
} from "./contracts.js";
import { getDagGraphIndex, type DagGraphIndex, type ValidatedDagDefinition } from "./validation.js";

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

export const DagRunOutcomeResultTag = {
  NonTerminal: "non-terminal",
  Terminal: "terminal",
} as const;
export type DagRunOutcomeResultTag =
  (typeof DagRunOutcomeResultTag)[keyof typeof DagRunOutcomeResultTag];

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

const DagRunStateToken = Symbol("DagRunState");

export class DagRunState<TOutputReference = unknown, TFailure = unknown> {
  readonly #graph: ValidatedDagDefinition<unknown>;

  constructor(
    token: typeof DagRunStateToken,
    graph: ValidatedDagDefinition<unknown>,
    readonly nodes: readonly DagNodeState<TOutputReference, TFailure>[],
  ) {
    if (token !== DagRunStateToken) {
      throw new TypeError("DAG run states must be created by this kernel.");
    }
    this.#graph = graph;
    Object.freeze(this.nodes);
    Object.freeze(this);
  }

  belongsTo(graph: ValidatedDagDefinition<unknown>): boolean {
    return this.#graph === graph;
  }
}

const QueuedNodeClassification = {
  Ready: "ready",
  Waiting: "waiting",
  Blocked: "blocked",
} as const;

type QueuedNodeClassification =
  | { readonly kind: typeof QueuedNodeClassification.Ready }
  | { readonly kind: typeof QueuedNodeClassification.Waiting }
  | {
      readonly kind: typeof QueuedNodeClassification.Blocked;
      readonly reason: DagBlockedReason;
      readonly blockedBy: readonly string[];
    };

function terminal(status: DagNodeStatus): boolean {
  return (
    status === DagNodeStatus.Succeeded ||
    status === DagNodeStatus.Failed ||
    status === DagNodeStatus.Blocked ||
    status === DagNodeStatus.Cancelled ||
    status === DagNodeStatus.Interrupted
  );
}

function makeRunState<TOutputReference, TFailure>(
  graph: ValidatedDagDefinition<unknown>,
  nodes: readonly DagNodeState<TOutputReference, TFailure>[],
): DagRunState<TOutputReference, TFailure> {
  return new DagRunState(DagRunStateToken, graph, nodes);
}

function assertMatchingState(graph: ValidatedDagDefinition<unknown>, state: DagRunState): void {
  if (!state.belongsTo(graph)) throw new TypeError("The DAG state belongs to a different graph.");
}

function dependencySummary<TPayload, TOutputReference, TFailure>(
  index: DagGraphIndex<TPayload>,
  states: readonly DagNodeState<TOutputReference, TFailure>[],
  nodeIndex: number,
): { readonly failedRequired: readonly string[]; readonly waiting: boolean } {
  const failedRequired: string[] = [];
  let waiting = false;
  for (const dependency of index.dependencies[nodeIndex] ?? []) {
    const status = states[dependency.index]?.status;
    if (dependency.mode === DagDependencyMode.Settled) {
      if (status === undefined || !terminal(status)) waiting = true;
      continue;
    }
    if (status === DagNodeStatus.Succeeded) continue;
    if (status !== undefined && terminal(status)) {
      failedRequired.push(index.nodes[dependency.index]?.id ?? "");
    } else waiting = true;
  }
  return { failedRequired, waiting };
}

function classifyQueuedNode<TPayload, TOutputReference, TFailure>(
  index: DagGraphIndex<TPayload>,
  states: readonly DagNodeState<TOutputReference, TFailure>[],
  nodeIndex: number,
): QueuedNodeClassification {
  if (states[nodeIndex]?.status !== DagNodeStatus.Queued) {
    return { kind: QueuedNodeClassification.Waiting };
  }
  const summary = dependencySummary(index, states, nodeIndex);
  if (summary.failedRequired.length > 0) {
    return {
      kind: QueuedNodeClassification.Blocked,
      reason: DagBlockedReason.RequiredDependency,
      blockedBy: summary.failedRequired,
    };
  }
  if (summary.waiting) return { kind: QueuedNodeClassification.Waiting };

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
  return { kind: QueuedNodeClassification.Ready };
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function freezeOutputs<TOutputReference>(
  outputs: DagNamedOutputs<TOutputReference>,
): DagNamedOutputs<TOutputReference> {
  return Object.freeze(
    Object.fromEntries(Object.entries(outputs)),
  ) as DagNamedOutputs<TOutputReference>;
}

function validResultShape(result: unknown): result is DagNodeResult {
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

function canonicalTransition<TOutputReference, TFailure>(
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
      return Object.freeze({
        nodeId,
        status: DagNodeStatus.Succeeded,
        outputs: result.outputs,
      });
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

function nodeStateFromTransition<TOutputReference, TFailure>(
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
        blockedBy: Object.freeze([...transition.blockedBy]),
      });
    case DagTransitionType.Cancel:
      return Object.freeze({
        nodeId: transition.nodeId,
        status: DagNodeStatus.Cancelled,
        ...(transition.reason === undefined ? {} : { reason: transition.reason }),
      });
  }
}

function transitionTargetStatus(transition: DagTransition): DagNodeStatus {
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
    case DagTransitionType.Start: {
      const running = state.nodes.filter((node) => node.status === DagNodeStatus.Running).length;
      return (
        running < graph.concurrency &&
        classifyQueuedNode(index, state.nodes, nodeIndex).kind === QueuedNodeClassification.Ready
      );
    }
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

export function createDagRunState<TPayload, TOutputReference = unknown, TFailure = unknown>(
  graph: ValidatedDagDefinition<TPayload>,
): DagRunState<TOutputReference, TFailure> {
  getDagGraphIndex(graph);
  return makeRunState(
    graph,
    graph.nodes.map((node) => Object.freeze({ nodeId: node.id, status: DagNodeStatus.Queued })),
  );
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
  return {
    _tag: DagTransitionResultTag.Applied,
    state: makeRunState(graph, nodes),
    transition: accepted,
  };
}

export function deriveDagSchedulingStep<TPayload, TOutputReference = unknown, TFailure = unknown>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TOutputReference, TFailure>,
): DagSchedulingStep<TOutputReference, TFailure> {
  assertMatchingState(graph, state);
  const index = getDagGraphIndex(graph);
  const nodes = [...state.nodes];
  const transitions: DagTransition<TOutputReference, TFailure>[] = [];

  for (const nodeIndex of index.topologicalOrder) {
    const classification = classifyQueuedNode(index, nodes, nodeIndex);
    if (classification.kind !== QueuedNodeClassification.Blocked) continue;
    const nodeId = index.nodes[nodeIndex]?.id ?? "";
    const transition = canonicalTransition<TOutputReference, TFailure>({
      runId: graph.runId,
      nodeId,
      type: DagTransitionType.Block,
      reason: classification.reason,
      blockedBy: classification.blockedBy,
    });
    nodes[nodeIndex] = nodeStateFromTransition(transition);
    transitions.push(transition);
  }

  const nextState = transitions.length > 0 ? makeRunState(graph, nodes) : state;
  const running = nodes.filter((node) => node.status === DagNodeStatus.Running).length;
  const available = Math.max(0, graph.concurrency - running);
  const readyNodeIds: string[] = [];
  for (
    let nodeIndex = 0;
    nodeIndex < nodes.length && readyNodeIds.length < available;
    nodeIndex++
  ) {
    if (classifyQueuedNode(index, nodes, nodeIndex).kind === QueuedNodeClassification.Ready) {
      readyNodeIds.push(index.nodes[nodeIndex]?.id ?? "");
    }
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
  return Object.hasOwn(node.outputs, outputName) ? node.outputs[outputName] : undefined;
}
