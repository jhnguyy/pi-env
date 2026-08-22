import * as DagContracts from "../contracts.js";
import * as ValidatedGraph from "./validated-graph.js";

const DagRunStateToken = Symbol("DagRunState");
const runningCounts = new WeakMap<DagRunState, number>();

export class DagRunState<TOutputReference = unknown, TFailure = unknown> {
  readonly #graph: ValidatedGraph.ValidatedDagDefinition<unknown>;

  constructor(
    token: typeof DagRunStateToken,
    graph: ValidatedGraph.ValidatedDagDefinition<unknown>,
    readonly nodes: readonly DagContracts.DagNodeState<TOutputReference, TFailure>[],
  ) {
    if (token !== DagRunStateToken) {
      throw new TypeError("DAG run states must be created by this kernel.");
    }
    this.#graph = graph;
    Object.freeze(this.nodes);
    Object.freeze(this);
  }

  belongsTo(graph: ValidatedGraph.ValidatedDagDefinition<unknown>): boolean {
    return this.#graph === graph;
  }
}

export function makeRunState<TOutputReference, TFailure>(
  graph: ValidatedGraph.ValidatedDagDefinition<unknown>,
  nodes: readonly DagContracts.DagNodeState<TOutputReference, TFailure>[],
  runningCount: number,
): DagRunState<TOutputReference, TFailure> {
  const state = new DagRunState(DagRunStateToken, graph, nodes);
  runningCounts.set(state, runningCount);
  return state;
}

export function getRunningCount(state: DagRunState): number {
  const count = runningCounts.get(state);
  if (count === undefined) throw new TypeError("The DAG state was not created by this kernel.");
  return count;
}

export function assertMatchingState(
  graph: ValidatedGraph.ValidatedDagDefinition<unknown>,
  state: DagRunState,
): void {
  if (!state.belongsTo(graph)) throw new TypeError("The DAG state belongs to a different graph.");
}

export function createDagRunState<TPayload, TOutputReference = unknown, TFailure = unknown>(
  graph: ValidatedGraph.ValidatedDagDefinition<TPayload>,
): DagRunState<TOutputReference, TFailure> {
  ValidatedGraph.getDagGraphIndex(graph);
  return makeRunState(
    graph,
    graph.nodes.map((node) => Object.freeze({ nodeId: node.id, status: DagContracts.DagNodeStatus.Queued })),
    0,
  );
}
