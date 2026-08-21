import {
  DagCompletionGuardKind,
  DagDefaultValidationLimits,
  DagDependencyMode,
  DagExecutorKind,
  type DagDefinition,
  type DagDependency,
  type DagDependencyMode as DagDependencyModeValue,
  type DagNode,
  type DagValidationLimits,
} from "./contracts.js";

export const DagValidationResultTag = {
  Valid: "valid",
  Invalid: "invalid",
} as const;
export type DagValidationResultTag =
  (typeof DagValidationResultTag)[keyof typeof DagValidationResultTag];

export const DagValidationErrorTag = {
  InvalidLimits: "invalid-limits",
  EmptyGraph: "empty-graph",
  NodeLimitExceeded: "node-limit-exceeded",
  EdgeLimitExceeded: "edge-limit-exceeded",
  ConcurrencyLimitExceeded: "concurrency-limit-exceeded",
  InvalidRunId: "invalid-run-id",
  InvalidNodeId: "invalid-node-id",
  DuplicateNode: "duplicate-node",
  InvalidExecutor: "invalid-executor",
  UnsupportedExecutorKind: "unsupported-executor-kind",
  MissingDependency: "missing-dependency",
  SelfDependency: "self-dependency",
  DuplicateDependency: "duplicate-dependency",
  UnsupportedDependencyMode: "unsupported-dependency-mode",
  InvalidCompletionGuard: "invalid-completion-guard",
  Cycle: "cycle",
} as const;
export type DagValidationErrorTag =
  (typeof DagValidationErrorTag)[keyof typeof DagValidationErrorTag];

export type DagValidationError =
  | { readonly _tag: typeof DagValidationErrorTag.InvalidLimits }
  | { readonly _tag: typeof DagValidationErrorTag.EmptyGraph }
  | {
      readonly _tag:
        | typeof DagValidationErrorTag.NodeLimitExceeded
        | typeof DagValidationErrorTag.EdgeLimitExceeded
        | typeof DagValidationErrorTag.ConcurrencyLimitExceeded;
      readonly limit: number;
      readonly actual: number;
    }
  | { readonly _tag: typeof DagValidationErrorTag.InvalidRunId }
  | { readonly _tag: typeof DagValidationErrorTag.InvalidNodeId; readonly nodeIndex: number }
  | {
      readonly _tag: typeof DagValidationErrorTag.DuplicateNode;
      readonly nodeId: string;
      readonly firstIndex: number;
      readonly duplicateIndex: number;
    }
  | { readonly _tag: typeof DagValidationErrorTag.InvalidExecutor; readonly nodeId: string }
  | {
      readonly _tag: typeof DagValidationErrorTag.UnsupportedExecutorKind;
      readonly nodeId: string;
      readonly kind: unknown;
    }
  | {
      readonly _tag:
        | typeof DagValidationErrorTag.MissingDependency
        | typeof DagValidationErrorTag.DuplicateDependency;
      readonly nodeId: string;
      readonly dependencyId: string;
    }
  | { readonly _tag: typeof DagValidationErrorTag.SelfDependency; readonly nodeId: string }
  | {
      readonly _tag: typeof DagValidationErrorTag.UnsupportedDependencyMode;
      readonly nodeId: string;
      readonly dependencyId: string;
      readonly mode: unknown;
    }
  | {
      readonly _tag: typeof DagValidationErrorTag.InvalidCompletionGuard;
      readonly nodeId: string;
    }
  | { readonly _tag: typeof DagValidationErrorTag.Cycle; readonly nodeIds: readonly string[] };

interface IndexedDependency {
  readonly index: number;
  readonly mode: DagDependencyModeValue;
}

export interface DagGraphIndex<TPayload> {
  readonly nodeById: ReadonlyMap<string, number>;
  readonly dependencies: readonly (readonly IndexedDependency[])[];
  readonly guardIndices: readonly (readonly number[] | undefined)[];
  readonly topologicalOrder: readonly number[];
  readonly nodes: readonly DagNode<TPayload>[];
}

const ValidatedDagToken = Symbol("ValidatedDag");
const graphIndices = new WeakMap<object, DagGraphIndex<unknown>>();

export class ValidatedDagDefinition<TPayload = unknown> {
  readonly #brand = true;

  constructor(
    token: typeof ValidatedDagToken,
    readonly runId: string,
    readonly concurrency: number,
    readonly nodes: readonly DagNode<TPayload>[],
  ) {
    if (token !== ValidatedDagToken) {
      throw new TypeError("Validated DAGs must be created by validateDagDefinition.");
    }
    Object.freeze(this);
  }
}

export type DagValidationResult<TPayload = unknown> =
  | {
      readonly _tag: typeof DagValidationResultTag.Valid;
      readonly graph: ValidatedDagDefinition<TPayload>;
    }
  | {
      readonly _tag: typeof DagValidationResultTag.Invalid;
      readonly errors: readonly DagValidationError[];
    };

export function getDagGraphIndex<TPayload>(
  graph: ValidatedDagDefinition<TPayload>,
): DagGraphIndex<TPayload> {
  const index = graphIndices.get(graph);
  if (!index) throw new TypeError("The DAG was not created by this kernel.");
  return index as DagGraphIndex<TPayload>;
}

function invalid<TPayload>(errors: readonly DagValidationError[]): DagValidationResult<TPayload> {
  return { _tag: DagValidationResultTag.Invalid, errors: Object.freeze([...errors]) };
}

function validLimits(limits: DagValidationLimits): boolean {
  return [limits.maxNodes, limits.maxEdges, limits.maxConcurrency].every(
    (limit) => Number.isSafeInteger(limit) && limit > 0,
  );
}

function supportedMode(mode: unknown): mode is DagDependencyModeValue {
  return mode === DagDependencyMode.Required || mode === DagDependencyMode.Settled;
}

function supportedExecutorKind(kind: unknown): boolean {
  return (
    kind === DagExecutorKind.Subagent ||
    kind === DagExecutorKind.Transform ||
    kind === DagExecutorKind.Materialize
  );
}

function frozenNode<TPayload>(node: DagNode<TPayload>): DagNode<TPayload> {
  const completionGuard = node.completionGuard
    ? Object.freeze({
        kind: node.completionGuard.kind,
        dependencyIds: Object.freeze([...node.completionGuard.dependencyIds]),
      })
    : undefined;
  return Object.freeze({
    id: node.id,
    executor: Object.freeze({
      kind: node.executor.kind,
      key: node.executor.key,
      payload: node.executor.payload,
    }),
    dependencies: Object.freeze(
      node.dependencies.map((dependency) => Object.freeze({ ...dependency })),
    ),
    ...(completionGuard ? { completionGuard } : {}),
  });
}

interface DfsFrame {
  readonly node: number;
  next: number;
}

function finishOrder(adjacency: readonly (readonly number[])[]): number[] {
  const visited = new Uint8Array(adjacency.length);
  const order: number[] = [];
  for (let start = 0; start < adjacency.length; start++) {
    if (visited[start] === 1) continue;
    visited[start] = 1;
    const stack: DfsFrame[] = [{ node: start, next: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (!frame) break;
      const next = adjacency[frame.node]?.[frame.next++];
      if (next !== undefined && visited[next] === 0) {
        visited[next] = 1;
        stack.push({ node: next, next: 0 });
      } else if (next === undefined) {
        order.push(frame.node);
        stack.pop();
      }
    }
  }
  return order;
}

function reversedAdjacency(adjacency: readonly (readonly number[])[]): number[][] {
  const reversed = Array.from({ length: adjacency.length }, (): number[] => []);
  for (let node = 0; node < adjacency.length; node++) {
    for (const dependency of adjacency[node] ?? []) reversed[dependency]?.push(node);
  }
  return reversed;
}

function collectComponent(
  start: number,
  adjacency: readonly (readonly number[])[],
  visited: Uint8Array,
): number[] {
  const component: number[] = [];
  const stack = [start];
  visited[start] = 1;
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    component.push(node);
    for (const next of adjacency[node] ?? []) {
      if (visited[next] === 1) continue;
      visited[next] = 1;
      stack.push(next);
    }
  }
  return component;
}

function cyclicNodeIds(
  nodes: readonly DagNode[],
  dependencies: readonly (readonly IndexedDependency[])[],
): string[] {
  const adjacency = dependencies.map((items) => items.map((item) => item.index));
  const reversed = reversedAdjacency(adjacency);
  const visited = new Uint8Array(nodes.length);
  const cyclic = new Uint8Array(nodes.length);
  const order = finishOrder(adjacency);
  for (let cursor = order.length - 1; cursor >= 0; cursor--) {
    const start = order[cursor];
    if (start === undefined || visited[start] === 1) continue;
    const component = collectComponent(start, reversed, visited);
    if (component.length > 1 || adjacency[start]?.includes(start)) {
      for (const node of component) cyclic[node] = 1;
    }
  }
  return nodes.filter((_node, index) => cyclic[index] === 1).map((node) => node.id);
}

function topologicalOrder(
  nodeCount: number,
  dependencies: readonly (readonly IndexedDependency[])[],
): number[] {
  const indegree = dependencies.map((items) => items.length);
  const dependents = Array.from({ length: nodeCount }, (): number[] => []);
  for (let consumer = 0; consumer < nodeCount; consumer++) {
    for (const dependency of dependencies[consumer] ?? []) {
      dependents[dependency.index]?.push(consumer);
    }
  }
  const queue = indegree.flatMap((degree, index) => (degree === 0 ? [index] : []));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const producer = queue[cursor];
    if (producer === undefined) continue;
    for (const consumer of dependents[producer] ?? []) {
      const next = (indegree[consumer] ?? 0) - 1;
      indegree[consumer] = next;
      if (next === 0) queue.push(consumer);
    }
  }
  return queue;
}

function guardIsValid<TPayload>(
  node: DagNode<TPayload>,
  dependencyModes: ReadonlyMap<string, DagDependencyModeValue>,
): boolean {
  const guard = node.completionGuard;
  if (!guard) return true;
  if (guard.kind !== DagCompletionGuardKind.AtLeastOneSucceeded) return false;
  if (guard.dependencyIds.length === 0) return false;
  if (guard.dependencyIds.length > node.dependencies.length) return false;
  if (new Set(guard.dependencyIds).size !== guard.dependencyIds.length) return false;
  return guard.dependencyIds.every(
    (dependencyId) => dependencyModes.get(dependencyId) === DagDependencyMode.Settled,
  );
}

function boundaryError(
  definition: DagDefinition,
  limits: DagValidationLimits,
): DagValidationError | undefined {
  if (!validLimits(limits)) return { _tag: DagValidationErrorTag.InvalidLimits };
  if (definition.nodes.length > limits.maxNodes) {
    return {
      _tag: DagValidationErrorTag.NodeLimitExceeded,
      limit: limits.maxNodes,
      actual: definition.nodes.length,
    };
  }
  let edges = 0;
  for (const node of definition.nodes) {
    edges += node.dependencies.length;
    if (edges > limits.maxEdges) {
      return {
        _tag: DagValidationErrorTag.EdgeLimitExceeded,
        limit: limits.maxEdges,
        actual: edges,
      };
    }
  }
  return undefined;
}

function collectDefinitionErrors(
  definition: DagDefinition,
  limits: DagValidationLimits,
  errors: DagValidationError[],
): void {
  if (definition.nodes.length === 0) errors.push({ _tag: DagValidationErrorTag.EmptyGraph });
  if (typeof definition.runId !== "string" || definition.runId.length === 0) {
    errors.push({ _tag: DagValidationErrorTag.InvalidRunId });
  }
  if (
    !Number.isSafeInteger(definition.concurrency) ||
    definition.concurrency < 1 ||
    definition.concurrency > limits.maxConcurrency
  ) {
    errors.push({
      _tag: DagValidationErrorTag.ConcurrencyLimitExceeded,
      limit: limits.maxConcurrency,
      actual: definition.concurrency,
    });
  }
}

function collectNodeErrors(
  definition: DagDefinition,
  errors: DagValidationError[],
): Map<string, number> {
  const nodeById = new Map<string, number>();
  for (let index = 0; index < definition.nodes.length; index++) {
    const node = definition.nodes[index];
    if (!node) continue;
    if (typeof node.id !== "string" || node.id.length === 0) {
      errors.push({ _tag: DagValidationErrorTag.InvalidNodeId, nodeIndex: index });
      continue;
    }
    const firstIndex = nodeById.get(node.id);
    if (firstIndex === undefined) nodeById.set(node.id, index);
    else {
      errors.push({
        _tag: DagValidationErrorTag.DuplicateNode,
        nodeId: node.id,
        firstIndex,
        duplicateIndex: index,
      });
    }
    if (typeof node.executor.key !== "string" || node.executor.key.length === 0) {
      errors.push({ _tag: DagValidationErrorTag.InvalidExecutor, nodeId: node.id });
    }
    if (!supportedExecutorKind(node.executor.kind)) {
      errors.push({
        _tag: DagValidationErrorTag.UnsupportedExecutorKind,
        nodeId: node.id,
        kind: node.executor.kind,
      });
    }
  }
  return nodeById;
}

function collectDependencyError(
  nodeId: string,
  dependency: DagDependency,
  nodeById: ReadonlyMap<string, number>,
  dependencyModes: Map<string, DagDependencyModeValue>,
  errors: DagValidationError[],
): void {
  const modeSupported = supportedMode(dependency.mode);
  if (dependencyModes.has(dependency.nodeId)) {
    errors.push({
      _tag: DagValidationErrorTag.DuplicateDependency,
      nodeId,
      dependencyId: dependency.nodeId,
    });
  } else if (modeSupported) dependencyModes.set(dependency.nodeId, dependency.mode);
  if (!modeSupported) {
    errors.push({
      _tag: DagValidationErrorTag.UnsupportedDependencyMode,
      nodeId,
      dependencyId: dependency.nodeId,
      mode: dependency.mode,
    });
  }
  if (!nodeById.has(dependency.nodeId)) {
    errors.push({
      _tag: DagValidationErrorTag.MissingDependency,
      nodeId,
      dependencyId: dependency.nodeId,
    });
  } else if (dependency.nodeId === nodeId) {
    errors.push({ _tag: DagValidationErrorTag.SelfDependency, nodeId });
  }
}

function collectDependencyErrors(
  definition: DagDefinition,
  nodeById: ReadonlyMap<string, number>,
  errors: DagValidationError[],
): void {
  for (const node of definition.nodes) {
    const dependencyModes = new Map<string, DagDependencyModeValue>();
    for (const dependency of node.dependencies) {
      collectDependencyError(node.id, dependency, nodeById, dependencyModes, errors);
    }
    if (!guardIsValid(node, dependencyModes)) {
      errors.push({ _tag: DagValidationErrorTag.InvalidCompletionGuard, nodeId: node.id });
    }
  }
}

function buildValidatedGraph<TPayload>(
  definition: DagDefinition<TPayload>,
  nodeById: ReadonlyMap<string, number>,
): DagValidationResult<TPayload> {
  const nodes = Object.freeze(definition.nodes.map(frozenNode));
  const dependencies = Object.freeze(
    nodes.map((node) =>
      Object.freeze(
        node.dependencies.map((dependency) => ({
          index: nodeById.get(dependency.nodeId) as number,
          mode: dependency.mode,
        })),
      ),
    ),
  );
  const cycleNodeIds = cyclicNodeIds(nodes, dependencies);
  if (cycleNodeIds.length > 0) {
    return invalid([{ _tag: DagValidationErrorTag.Cycle, nodeIds: cycleNodeIds }]);
  }
  const guardIndices = Object.freeze(
    nodes.map((node) =>
      node.completionGuard
        ? Object.freeze(
            node.completionGuard.dependencyIds.map(
              (dependencyId) => nodeById.get(dependencyId) as number,
            ),
          )
        : undefined,
    ),
  );
  const graph = new ValidatedDagDefinition(
    ValidatedDagToken,
    definition.runId,
    definition.concurrency,
    nodes,
  );
  graphIndices.set(graph, {
    nodeById,
    dependencies,
    guardIndices,
    topologicalOrder: Object.freeze(topologicalOrder(nodes.length, dependencies)),
    nodes,
  });
  return { _tag: DagValidationResultTag.Valid, graph };
}

export function validateDagDefinition<TPayload = unknown>(
  definition: DagDefinition<TPayload>,
  limits: DagValidationLimits = DagDefaultValidationLimits,
): DagValidationResult<TPayload> {
  const exceededBoundary = boundaryError(definition, limits);
  if (exceededBoundary) return invalid([exceededBoundary]);
  const errors: DagValidationError[] = [];
  collectDefinitionErrors(definition, limits, errors);
  const nodeById = collectNodeErrors(definition, errors);
  collectDependencyErrors(definition, nodeById, errors);
  return errors.length > 0 ? invalid(errors) : buildValidatedGraph(definition, nodeById);
}
