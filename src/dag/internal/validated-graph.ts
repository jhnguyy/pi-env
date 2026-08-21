import type {
  DagDefinition,
  DagDependencyMode as DagDependencyModeValue,
  DagNode,
} from "../contracts.js";
import { cyclicNodeIndices, topologicalOrder } from "./graph-order.js";

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

const BuildValidatedGraphResultTag = {
  Valid: "valid",
  Cycle: "cycle",
} as const;

type BuildValidatedGraphResult<TPayload> =
  | {
      readonly _tag: typeof BuildValidatedGraphResultTag.Valid;
      readonly graph: ValidatedDagDefinition<TPayload>;
    }
  | {
      readonly _tag: typeof BuildValidatedGraphResultTag.Cycle;
      readonly nodeIds: readonly string[];
    };

export function getDagGraphIndex<TPayload>(
  graph: ValidatedDagDefinition<TPayload>,
): DagGraphIndex<TPayload> {
  const index = graphIndices.get(graph);
  if (!index) throw new TypeError("The DAG was not created by this kernel.");
  return index as DagGraphIndex<TPayload>;
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

export function buildValidatedGraph<TPayload>(
  definition: DagDefinition<TPayload>,
  nodeById: ReadonlyMap<string, number>,
): BuildValidatedGraphResult<TPayload> {
  const ownedNodeById = new Map(nodeById);
  const nodes = Object.freeze(definition.nodes.map(frozenNode));
  const dependencies = Object.freeze(
    nodes.map((node) =>
      Object.freeze(
        node.dependencies.map((dependency) => ({
          index: ownedNodeById.get(dependency.nodeId) as number,
          mode: dependency.mode,
        })),
      ),
    ),
  );
  const cycleNodeIds = cyclicNodeIndices(nodes.length, dependencies).map(
    (index) => nodes[index]?.id ?? "",
  );
  if (cycleNodeIds.length > 0) {
    return { _tag: BuildValidatedGraphResultTag.Cycle, nodeIds: Object.freeze(cycleNodeIds) };
  }
  const guardIndices = Object.freeze(
    nodes.map((node) =>
      node.completionGuard
        ? Object.freeze(
            node.completionGuard.dependencyIds.map(
              (dependencyId) => ownedNodeById.get(dependencyId) as number,
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
    nodeById: ownedNodeById,
    dependencies,
    guardIndices,
    topologicalOrder: Object.freeze(topologicalOrder(nodes.length, dependencies)),
    nodes,
  });
  return { _tag: BuildValidatedGraphResultTag.Valid, graph };
}
