import { expect } from "vitest";
import {
  DagExecutorKind,
  DagNodeResultTag,
  DagTransitionResultTag,
  DagTransitionType,
  DagValidationResultTag,
  getDagNodeState,
  reduceDagRunState,
  validateDagDefinition,
  type DagDefinition,
  type DagNode,
  type DagNodeResult,
  type DagNodeStatus,
  type DagRunState,
  type DagTransition,
  type ValidatedDagDefinition,
} from "../index.js";

export const executor = {
  kind: DagExecutorKind.Transform,
  key: "test",
  payload: undefined,
} as const;

export function node(
  id: string,
  dependencies: DagNode["dependencies"] = [],
  completionGuard?: DagNode["completionGuard"],
): DagNode {
  return { id, executor, dependencies, ...(completionGuard ? { completionGuard } : {}) };
}

export function definition(nodes: readonly DagNode[], concurrency = 2): DagDefinition {
  return { runId: "run-test", concurrency, nodes };
}

export function graph(nodes: readonly DagNode[], concurrency = 4): ValidatedDagDefinition {
  const result = validateDagDefinition({ runId: "run-test", concurrency, nodes });
  expect(result._tag).toBe(DagValidationResultTag.Valid);
  if (result._tag !== DagValidationResultTag.Valid) throw new Error(JSON.stringify(result.errors));
  return result.graph;
}

type WithoutRunId<T> = T extends unknown ? Omit<T, "runId"> : never;

export function apply(
  dag: ValidatedDagDefinition,
  state: DagRunState,
  transition: WithoutRunId<DagTransition>,
): DagRunState {
  const result = reduceDagRunState(dag, state, {
    ...transition,
    runId: dag.runId,
  } as DagTransition);
  expect(result._tag).toBe(DagTransitionResultTag.Applied);
  if (result._tag !== DagTransitionResultTag.Applied) throw new Error(JSON.stringify(result.error));
  return result.state;
}

export function terminalResult(tag: DagNodeResult["_tag"]): DagNodeResult {
  switch (tag) {
    case DagNodeResultTag.Succeeded:
      return { _tag: tag, outputs: {} };
    case DagNodeResultTag.Failed:
      return { _tag: tag, failure: "failed" };
    case DagNodeResultTag.Cancelled:
      return { _tag: tag, reason: "cancelled" };
    case DagNodeResultTag.Interrupted:
      return { _tag: tag, reason: "interrupted" };
  }
}

export function finish(
  dag: ValidatedDagDefinition,
  state: DagRunState,
  nodeId: string,
  result: DagNodeResult,
): DagRunState {
  return apply(dag, apply(dag, state, { type: DagTransitionType.Start, nodeId }), {
    type: DagTransitionType.Complete,
    nodeId,
    result,
  });
}

export function status(
  dag: ValidatedDagDefinition,
  state: DagRunState,
  nodeId: string,
): DagNodeStatus {
  const value = getDagNodeState(dag, state, nodeId);
  if (!value) throw new Error(`Missing node ${nodeId}`);
  return value.status;
}
