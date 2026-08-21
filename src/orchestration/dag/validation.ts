import {
  DagCompletionGuardKind,
  DagDefaultValidationLimits,
  DagDependencyMode,
  DagExecutorKind,
  DagValidationErrorTag,
  DagValidationResultTag,
  type DagCompletionGuard,
  type DagDefinition,
  type DagDependency,
  type DagExecutor,
  type DagNode,
  type DagValidationError,
  type DagValidationLimits,
  type DagValidationResult,
  type ValidatedDagDefinition,
} from "./types.js";

function validLimits(limits: unknown): limits is DagValidationLimits {
  if (typeof limits !== "object" || limits === null) return false;
  const candidate = limits as Partial<DagValidationLimits>;
  return [candidate.maxNodes, candidate.maxEdges, candidate.maxConcurrency].every(
    (limit) => Number.isSafeInteger(limit) && Number(limit) > 0,
  );
}

function validDefinitionStructure(definition: unknown): definition is DagDefinition {
  if (typeof definition !== "object" || definition === null) return false;
  const nodes = (definition as { readonly nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.every((node) => {
    if (typeof node !== "object" || node === null) return false;
    const candidate = node as {
      readonly dependencies?: unknown;
      readonly completionGuard?: unknown;
    };
    if (!Array.isArray(candidate.dependencies)) return false;
    if (
      !candidate.dependencies.every(
        (dependency) =>
          typeof dependency === "object" &&
          dependency !== null &&
          typeof (dependency as { readonly nodeId?: unknown }).nodeId === "string",
      )
    ) {
      return false;
    }
    if (candidate.completionGuard === undefined) return true;
    if (typeof candidate.completionGuard !== "object" || candidate.completionGuard === null) {
      return false;
    }
    const dependencyIds = (candidate.completionGuard as { readonly dependencyIds?: unknown })
      .dependencyIds;
    return Array.isArray(dependencyIds) && dependencyIds.every((id) => typeof id === "string");
  });
}

function supportedDependencyMode(mode: unknown): mode is DagDependency["mode"] {
  return mode === DagDependencyMode.Required || mode === DagDependencyMode.Settled;
}

function supportedExecutorKind(kind: unknown): kind is DagExecutor["kind"] {
  return (
    kind === DagExecutorKind.Subagent ||
    kind === DagExecutorKind.Transform ||
    kind === DagExecutorKind.Materialize
  );
}

function edgeCount(definition: DagDefinition): number {
  let count = 0;
  for (const node of definition.nodes) count += node.dependencies.length;
  return count;
}

function dependencyIndexes(definition: DagDefinition): number[][] {
  const nodeIndex = new Map(definition.nodes.map((node, index) => [node.id, index] as const));
  return definition.nodes.map((node) =>
    node.dependencies.flatMap((dependency) => {
      const index = nodeIndex.get(dependency.nodeId);
      return index === undefined ? [] : [index];
    }),
  );
}

function nodeReachesItself(
  dependencies: readonly (readonly number[])[],
  startIndex: number,
): boolean {
  const stack = [...(dependencies[startIndex] ?? [])];
  const visited = new Uint8Array(dependencies.length);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    if (current === startIndex) return true;
    if (visited[current] === 1) continue;
    visited[current] = 1;
    for (const dependency of dependencies[current] ?? []) stack.push(dependency);
  }
  return false;
}

function cycleNodes(definition: DagDefinition): string[] {
  const dependencies = dependencyIndexes(definition);
  const nodeIds: string[] = [];
  for (let index = 0; index < definition.nodes.length; index++) {
    if (nodeReachesItself(dependencies, index)) {
      const node = definition.nodes[index];
      if (node) nodeIds.push(node.id);
    }
  }
  return nodeIds;
}

function validCompletionGuard(node: DagNode): boolean {
  const guard = node.completionGuard;
  if (!guard) return true;
  if (guard.kind !== DagCompletionGuardKind.AtLeastOneSucceeded) return false;
  if (guard.dependencyIds.length === 0) return false;

  const uniqueIds = new Set(guard.dependencyIds);
  if (uniqueIds.size !== guard.dependencyIds.length) return false;
  const modes = new Map(
    node.dependencies.map((dependency) => [dependency.nodeId, dependency.mode] as const),
  );
  return guard.dependencyIds.every(
    (dependencyId) => modes.get(dependencyId) === DagDependencyMode.Settled,
  );
}

function freezeDependency(dependency: DagDependency): DagDependency {
  return Object.freeze({ ...dependency });
}

function freezeGuard(guard: DagCompletionGuard | undefined): DagCompletionGuard | undefined {
  if (!guard) return undefined;
  return Object.freeze({
    kind: guard.kind,
    dependencyIds: Object.freeze([...guard.dependencyIds]),
  });
}

function freezeNode<TPayload>(node: DagNode<TPayload>): DagNode<TPayload> {
  const completionGuard = freezeGuard(node.completionGuard);
  const frozen: DagNode<TPayload> = {
    id: node.id,
    executor: Object.freeze({
      kind: node.executor.kind,
      key: node.executor.key,
      payload: node.executor.payload,
    }),
    dependencies: Object.freeze(node.dependencies.map(freezeDependency)),
    ...(completionGuard ? { completionGuard } : {}),
  };
  return Object.freeze(frozen);
}

function freezeDefinition<TPayload>(
  definition: DagDefinition<TPayload>,
): ValidatedDagDefinition<TPayload> {
  return Object.freeze({
    _tag: "ValidatedDagDefinition" as const,
    runId: definition.runId,
    concurrency: definition.concurrency,
    nodes: Object.freeze(definition.nodes.map(freezeNode)),
  });
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
  const actualEdgeCount = edgeCount(definition);
  if (actualEdgeCount > limits.maxEdges) {
    return {
      _tag: DagValidationErrorTag.EdgeLimitExceeded,
      limit: limits.maxEdges,
      actual: actualEdgeCount,
    };
  }
  return undefined;
}

function collectDefinitionErrors(
  definition: DagDefinition,
  limits: DagValidationLimits,
  errors: DagValidationError[],
): void {
  if (definition.nodes.length === 0) {
    errors.push({ _tag: DagValidationErrorTag.EmptyGraph });
  }
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

function collectExecutorErrors(node: DagNode, errors: DagValidationError[]): void {
  if (
    typeof node.executor !== "object" ||
    node.executor === null ||
    typeof node.executor.key !== "string" ||
    node.executor.key.length === 0
  ) {
    errors.push({ _tag: DagValidationErrorTag.InvalidExecutor, nodeId: node.id });
    return;
  }
  if (!supportedExecutorKind(node.executor.kind)) {
    errors.push({
      _tag: DagValidationErrorTag.UnsupportedExecutorKind,
      nodeId: node.id,
      kind: node.executor.kind,
    });
  }
}

function collectNodeErrors(definition: DagDefinition, errors: DagValidationError[]): Set<string> {
  const firstNodeIndex = new Map<string, number>();
  for (let nodeIndex = 0; nodeIndex < definition.nodes.length; nodeIndex++) {
    const node = definition.nodes[nodeIndex];
    if (!node) continue;
    if (typeof node.id !== "string" || node.id.length === 0) {
      errors.push({ _tag: DagValidationErrorTag.InvalidNodeId, nodeIndex });
      continue;
    }
    const firstIndex = firstNodeIndex.get(node.id);
    if (firstIndex === undefined) {
      firstNodeIndex.set(node.id, nodeIndex);
    } else {
      errors.push({
        _tag: DagValidationErrorTag.DuplicateNode,
        nodeId: node.id,
        firstIndex,
        duplicateIndex: nodeIndex,
      });
    }
    collectExecutorErrors(node, errors);
  }
  return new Set(firstNodeIndex.keys());
}

function collectDependencyError(
  node: DagNode,
  dependency: DagDependency,
  nodeIds: ReadonlySet<string>,
  errors: DagValidationError[],
): void {
  if (!supportedDependencyMode(dependency.mode)) {
    errors.push({
      _tag: DagValidationErrorTag.UnsupportedDependencyMode,
      nodeId: node.id,
      dependencyId: dependency.nodeId,
      mode: dependency.mode,
    });
  }
  if (!nodeIds.has(dependency.nodeId)) {
    errors.push({
      _tag: DagValidationErrorTag.MissingDependency,
      nodeId: node.id,
      dependencyId: dependency.nodeId,
    });
  } else if (dependency.nodeId === node.id) {
    errors.push({ _tag: DagValidationErrorTag.SelfDependency, nodeId: node.id });
  }
}

function collectDependencyErrors(
  definition: DagDefinition,
  nodeIds: ReadonlySet<string>,
  errors: DagValidationError[],
): void {
  for (const node of definition.nodes) {
    const dependencyIds = new Set<string>();
    for (const dependency of node.dependencies) {
      if (dependencyIds.has(dependency.nodeId)) {
        errors.push({
          _tag: DagValidationErrorTag.DuplicateDependency,
          nodeId: node.id,
          dependencyId: dependency.nodeId,
        });
      } else {
        dependencyIds.add(dependency.nodeId);
      }
      collectDependencyError(node, dependency, nodeIds, errors);
    }
    if (!validCompletionGuard(node)) {
      errors.push({ _tag: DagValidationErrorTag.InvalidCompletionGuard, nodeId: node.id });
    }
  }
}

function invalidResult(error: DagValidationError): {
  readonly _tag: typeof DagValidationResultTag.Invalid;
  readonly errors: readonly DagValidationError[];
} {
  return { _tag: DagValidationResultTag.Invalid, errors: Object.freeze([error]) };
}

export function validateDagDefinition<TPayload = unknown>(
  definition: DagDefinition<TPayload>,
  limits: DagValidationLimits = DagDefaultValidationLimits,
): DagValidationResult<TPayload> {
  if (!validDefinitionStructure(definition)) {
    return invalidResult({ _tag: DagValidationErrorTag.InvalidDefinition });
  }
  const untypedDefinition = definition as DagDefinition;
  const exceededBoundary = boundaryError(untypedDefinition, limits);
  if (exceededBoundary) return invalidResult(exceededBoundary);

  const errors: DagValidationError[] = [];
  collectDefinitionErrors(untypedDefinition, limits, errors);
  const nodeIds = collectNodeErrors(untypedDefinition, errors);
  collectDependencyErrors(untypedDefinition, nodeIds, errors);
  if (errors.length === 0) {
    const involvedNodeIds = cycleNodes(untypedDefinition);
    if (involvedNodeIds.length > 0) {
      errors.push({ _tag: DagValidationErrorTag.Cycle, nodeIds: involvedNodeIds });
    }
  }

  if (errors.length > 0) {
    return { _tag: DagValidationResultTag.Invalid, errors: Object.freeze(errors) };
  }
  return { _tag: DagValidationResultTag.Valid, graph: freezeDefinition(definition) };
}
