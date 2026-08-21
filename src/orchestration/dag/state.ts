import {
  DagBlockedReason,
  DagDependencyMode,
  DagNodeResultTag,
  DagNodeStatus,
  DagTransitionErrorTag,
  DagTransitionResultTag,
  DagTransitionType,
  type DagNamedOutputs,
  type DagNodeResult,
  type DagNodeState,
  type DagOutputReference,
  type DagTransition,
  type DagTransitionError,
  type DagTransitionResult,
  type ValidatedDagDefinition,
} from "./types.js";

const DagRunStateConstructorToken = Symbol("DagRunStateConstructor");

export class DagRunState<TReference extends DagOutputReference = DagOutputReference> {
  readonly #brand = true;
  readonly _tag = "DagRunState" as const;

  constructor(
    token: typeof DagRunStateConstructorToken,
    readonly runId: string,
    readonly nodes: readonly DagNodeState<TReference>[],
  ) {
    if (token !== DagRunStateConstructorToken) {
      throw new TypeError("DAG run states must be created by the kernel.");
    }
    Object.freeze(this.nodes);
    Object.freeze(this);
  }
}

export function isTerminalDagNodeStatus(status: DagNodeStatus): boolean {
  return (
    status === DagNodeStatus.Succeeded ||
    status === DagNodeStatus.Failed ||
    status === DagNodeStatus.Blocked ||
    status === DagNodeStatus.Cancelled ||
    status === DagNodeStatus.Interrupted
  );
}

function validOutputReference(reference: unknown): reference is DagOutputReference {
  return (
    typeof reference === "object" &&
    reference !== null &&
    typeof (reference as { readonly kind?: unknown }).kind === "string" &&
    (reference as { readonly kind: string }).kind.length > 0 &&
    Object.hasOwn(reference, "locator")
  );
}

function validOutputs(outputs: unknown): outputs is DagNamedOutputs {
  return (
    typeof outputs === "object" &&
    outputs !== null &&
    !Array.isArray(outputs) &&
    Object.entries(outputs).every(
      ([name, reference]) => name.length > 0 && validOutputReference(reference),
    )
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validFailure(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null) return false;
  const candidate = failure as { readonly code?: unknown; readonly message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

function validBlockedFields(candidate: Record<string, unknown>): boolean {
  const validReason =
    candidate.reason === DagBlockedReason.RequiredDependency ||
    candidate.reason === DagBlockedReason.CompletionGuard;
  const validIds =
    Array.isArray(candidate.blockedBy) &&
    candidate.blockedBy.every((nodeId) => typeof nodeId === "string");
  return validReason && validIds;
}

function validNodeResult(result: unknown): result is DagNodeResult {
  if (typeof result !== "object" || result === null) return false;
  const candidate = result as Record<string, unknown>;
  switch (candidate._tag) {
    case DagNodeResultTag.Succeeded:
      return validOutputs(candidate.outputs) && optionalString(candidate.summary);
    case DagNodeResultTag.Failed:
      return validFailure(candidate.failure);
    case DagNodeResultTag.Cancelled:
    case DagNodeResultTag.Interrupted:
      return optionalString(candidate.reason);
    default:
      return false;
  }
}

function validTransitionShape(transition: unknown): transition is DagTransition {
  if (typeof transition !== "object" || transition === null) return false;
  const candidate = transition as Record<string, unknown>;
  if (typeof candidate.runId !== "string" || typeof candidate.nodeId !== "string") return false;
  switch (candidate.type) {
    case DagTransitionType.Start:
      return true;
    case DagTransitionType.Complete:
      return validNodeResult(candidate.result);
    case DagTransitionType.Block:
      return validBlockedFields(candidate);
    case DagTransitionType.Cancel:
      return optionalString(candidate.reason);
    default:
      return false;
  }
}

function validNodeState(state: unknown): state is DagNodeState {
  if (typeof state !== "object" || state === null) return false;
  const candidate = state as Record<string, unknown>;
  if (typeof candidate.nodeId !== "string") return false;
  switch (candidate.status) {
    case DagNodeStatus.Queued:
    case DagNodeStatus.Running:
      return true;
    case DagNodeStatus.Succeeded:
      return validOutputs(candidate.outputs) && optionalString(candidate.summary);
    case DagNodeStatus.Failed:
      return validFailure(candidate.failure);
    case DagNodeStatus.Blocked:
      return validBlockedFields(candidate);
    case DagNodeStatus.Cancelled:
    case DagNodeStatus.Interrupted:
      return optionalString(candidate.reason);
    default:
      return false;
  }
}

export function dagRunStateMatchesGraph<TPayload, TReference extends DagOutputReference>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
): boolean {
  return (
    state instanceof DagRunState &&
    state._tag === "DagRunState" &&
    state.runId === graph.runId &&
    Array.isArray(state.nodes) &&
    state.nodes.length === graph.nodes.length &&
    state.nodes.every(
      (node, index) => validNodeState(node) && node.nodeId === graph.nodes[index]?.id,
    )
  );
}

export function canStartDagNode<TPayload, TReference extends DagOutputReference>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
  nodeId: string,
): boolean {
  if (!dagRunStateMatchesGraph(graph, state)) return false;
  if (
    state.nodes.filter((node) => node.status === DagNodeStatus.Running).length >= graph.concurrency
  ) {
    return false;
  }
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || getDagNodeState(state, nodeId)?.status !== DagNodeStatus.Queued) return false;
  for (const dependency of node.dependencies) {
    const dependencyState = getDagNodeState(state, dependency.nodeId);
    if (!dependencyState) return false;
    if (
      dependency.mode === DagDependencyMode.Required &&
      dependencyState.status !== DagNodeStatus.Succeeded
    ) {
      return false;
    }
    if (
      dependency.mode === DagDependencyMode.Settled &&
      !isTerminalDagNodeStatus(dependencyState.status)
    ) {
      return false;
    }
  }
  const guardedIds = node.completionGuard?.dependencyIds;
  return (
    !guardedIds ||
    guardedIds.some(
      (dependencyId) => getDagNodeState(state, dependencyId)?.status === DagNodeStatus.Succeeded,
    )
  );
}

function freezeRunState<TReference extends DagOutputReference>(
  runId: string,
  nodes: readonly DagNodeState<TReference>[],
): DagRunState<TReference> {
  return new DagRunState(DagRunStateConstructorToken, runId, nodes);
}

export function createDagRunState<
  TPayload,
  TReference extends DagOutputReference = DagOutputReference,
>(graph: ValidatedDagDefinition<TPayload>): DagRunState<TReference> {
  const nodes = graph.nodes.map((node) =>
    Object.freeze({ nodeId: node.id, status: DagNodeStatus.Queued }),
  );
  return freezeRunState(graph.runId, nodes);
}

export function getDagNodeState<TReference extends DagOutputReference = DagOutputReference>(
  state: DagRunState<TReference>,
  nodeId: string,
): DagNodeState<TReference> | undefined {
  return state.nodes.find((node) => node.nodeId === nodeId);
}

export function getDagOutputReference<TReference extends DagOutputReference = DagOutputReference>(
  state: DagRunState<TReference>,
  nodeId: string,
  outputName: string,
): TReference | undefined {
  const node = getDagNodeState(state, nodeId);
  if (node?.status !== DagNodeStatus.Succeeded) return undefined;
  return Object.hasOwn(node.outputs, outputName) ? node.outputs[outputName] : undefined;
}

function resultStatus(result: DagNodeResult): DagNodeStatus {
  switch (result._tag) {
    case DagNodeResultTag.Succeeded:
      return DagNodeStatus.Succeeded;
    case DagNodeResultTag.Failed:
      return DagNodeStatus.Failed;
    case DagNodeResultTag.Cancelled:
      return DagNodeStatus.Cancelled;
    case DagNodeResultTag.Interrupted:
      return DagNodeStatus.Interrupted;
  }
}

function transitionStatus(transition: DagTransition): DagNodeStatus {
  switch (transition.type) {
    case DagTransitionType.Start:
      return DagNodeStatus.Running;
    case DagTransitionType.Complete:
      return resultStatus(transition.result);
    case DagTransitionType.Block:
      return DagNodeStatus.Blocked;
    case DagTransitionType.Cancel:
      return DagNodeStatus.Cancelled;
  }
}

function invalidTransition(
  nodeId: string,
  from: DagNodeStatus,
  to: DagNodeStatus,
): DagTransitionError {
  return { _tag: DagTransitionErrorTag.InvalidTransition, nodeId, from, to };
}

function allowedTransition(from: DagNodeStatus, transition: DagTransition): boolean {
  switch (transition.type) {
    case DagTransitionType.Start:
      return from === DagNodeStatus.Queued;
    case DagTransitionType.Complete:
      return from === DagNodeStatus.Running;
    case DagTransitionType.Block:
      return from === DagNodeStatus.Queued;
    case DagTransitionType.Cancel:
      return from === DagNodeStatus.Queued || from === DagNodeStatus.Running;
  }
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validBlock<TPayload, TReference extends DagOutputReference>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
  transition: Extract<DagTransition<TReference>, { type: typeof DagTransitionType.Block }>,
): boolean {
  if (transition.blockedBy.length === 0) return false;
  const node = graph.nodes.find((candidate) => candidate.id === transition.nodeId);
  if (!node) return false;

  switch (transition.reason) {
    case DagBlockedReason.RequiredDependency: {
      const failedRequiredIds = node.dependencies
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
      return equalIds(transition.blockedBy, failedRequiredIds);
    }
    case DagBlockedReason.CompletionGuard: {
      const dependencyIds = node.completionGuard?.dependencyIds;
      if (!dependencyIds || !equalIds(transition.blockedBy, dependencyIds)) return false;
      const dependencyStates = dependencyIds.map((dependencyId) =>
        getDagNodeState(state, dependencyId),
      );
      return (
        dependencyStates.every(
          (dependencyState) =>
            dependencyState !== undefined && isTerminalDagNodeStatus(dependencyState.status),
        ) &&
        dependencyStates.every(
          (dependencyState) => dependencyState?.status !== DagNodeStatus.Succeeded,
        )
      );
    }
  }
}

function freezeOutputs<TReference extends DagOutputReference>(
  outputs: DagNamedOutputs<TReference>,
): DagNamedOutputs<TReference> {
  return Object.freeze(Object.fromEntries(Object.entries(outputs))) as DagNamedOutputs<TReference>;
}

function freezeResult<TReference extends DagOutputReference>(
  result: DagNodeResult<TReference>,
): DagNodeResult<TReference> {
  switch (result._tag) {
    case DagNodeResultTag.Succeeded:
      return Object.freeze({
        _tag: result._tag,
        outputs: freezeOutputs(result.outputs),
        ...(result.summary === undefined ? {} : { summary: result.summary }),
      });
    case DagNodeResultTag.Failed:
      return Object.freeze({
        _tag: result._tag,
        failure: Object.freeze({
          code: result.failure.code,
          message: result.failure.message,
        }),
      });
    case DagNodeResultTag.Cancelled:
    case DagNodeResultTag.Interrupted:
      return Object.freeze({
        _tag: result._tag,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
  }
}

function freezeTransition<TReference extends DagOutputReference>(
  transition: DagTransition<TReference>,
): DagTransition<TReference> {
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
        result: freezeResult(transition.result),
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

function stateFromResult<TReference extends DagOutputReference>(
  nodeId: string,
  result: DagNodeResult<TReference>,
): DagNodeState<TReference> {
  switch (result._tag) {
    case DagNodeResultTag.Succeeded:
      return Object.freeze({
        nodeId,
        status: DagNodeStatus.Succeeded,
        outputs: freezeOutputs(result.outputs),
        ...(result.summary === undefined ? {} : { summary: result.summary }),
      });
    case DagNodeResultTag.Failed:
      return Object.freeze({
        nodeId,
        status: DagNodeStatus.Failed,
        failure: Object.freeze({
          code: result.failure.code,
          message: result.failure.message,
        }),
      });
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

function nextNodeState<TReference extends DagOutputReference>(
  transition: DagTransition<TReference>,
): DagNodeState<TReference> {
  switch (transition.type) {
    case DagTransitionType.Start:
      return Object.freeze({ nodeId: transition.nodeId, status: DagNodeStatus.Running });
    case DagTransitionType.Complete:
      return stateFromResult(transition.nodeId, transition.result);
    case DagTransitionType.Block:
      return Object.freeze({
        nodeId: transition.nodeId,
        status: DagNodeStatus.Blocked,
        blockedBy: Object.freeze([...transition.blockedBy]),
        reason: transition.reason,
      });
    case DagTransitionType.Cancel:
      return Object.freeze({
        nodeId: transition.nodeId,
        status: DagNodeStatus.Cancelled,
        ...(transition.reason === undefined ? {} : { reason: transition.reason }),
      });
  }
}

function malformedTransitionError(transition: unknown): DagTransitionError {
  const nodeId =
    typeof transition === "object" &&
    transition !== null &&
    typeof (transition as { readonly nodeId?: unknown }).nodeId === "string"
      ? (transition as { readonly nodeId: string }).nodeId
      : undefined;
  return {
    _tag: DagTransitionErrorTag.MalformedTransition,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

function reductionInputError<TPayload, TReference extends DagOutputReference>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
  transition: DagTransition<TReference>,
): DagTransitionError | undefined {
  if (!validTransitionShape(transition)) return malformedTransitionError(transition);
  if (typeof state !== "object" || state === null || typeof state.runId !== "string") {
    return { _tag: DagTransitionErrorTag.InvalidState };
  }
  if (state.runId !== graph.runId) {
    return {
      _tag: DagTransitionErrorTag.RunMismatch,
      expectedRunId: graph.runId,
      actualRunId: state.runId,
    };
  }
  if (transition.runId !== graph.runId) {
    return {
      _tag: DagTransitionErrorTag.RunMismatch,
      expectedRunId: graph.runId,
      actualRunId: transition.runId,
    };
  }
  return dagRunStateMatchesGraph(graph, state)
    ? undefined
    : { _tag: DagTransitionErrorTag.InvalidState };
}

function transitionRuleError<TPayload, TReference extends DagOutputReference>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
  current: DagNodeState<TReference>,
  transition: DagTransition<TReference>,
): DagTransitionError | undefined {
  const to = transitionStatus(transition);
  if (!allowedTransition(current.status, transition)) {
    return invalidTransition(transition.nodeId, current.status, to);
  }
  if (
    transition.type === DagTransitionType.Start &&
    !canStartDagNode(graph, state, transition.nodeId)
  ) {
    return invalidTransition(transition.nodeId, current.status, to);
  }
  if (transition.type === DagTransitionType.Block && !validBlock(graph, state, transition)) {
    return {
      _tag: DagTransitionErrorTag.InvalidBlock,
      nodeId: transition.nodeId,
      blockedBy: transition.blockedBy,
      reason: transition.reason,
    };
  }
  return undefined;
}

function rejected<TReference extends DagOutputReference>(
  error: DagTransitionError,
): DagTransitionResult<TReference> {
  return { _tag: DagTransitionResultTag.Rejected, error };
}

export function reduceDagRunState<
  TPayload,
  TReference extends DagOutputReference = DagOutputReference,
>(
  graph: ValidatedDagDefinition<TPayload>,
  state: DagRunState<TReference>,
  transition: DagTransition<TReference>,
): DagTransitionResult<TReference> {
  const inputError = reductionInputError(graph, state, transition);
  if (inputError) return rejected(inputError);

  const nodeIndex = state.nodes.findIndex((node) => node.nodeId === transition.nodeId);
  const current = state.nodes[nodeIndex];
  if (nodeIndex < 0 || !current) {
    return rejected({ _tag: DagTransitionErrorTag.UnknownNode, nodeId: transition.nodeId });
  }
  const ruleError = transitionRuleError(graph, state, current, transition);
  if (ruleError) return rejected(ruleError);

  const acceptedTransition = freezeTransition(transition);
  const nodes = [...state.nodes];
  nodes[nodeIndex] = nextNodeState(acceptedTransition);
  return {
    _tag: DagTransitionResultTag.Applied,
    state: freezeRunState(state.runId, nodes),
    transition: acceptedTransition,
  };
}
