import { describe, expect, it } from "vitest";
import {
  DagBlockedReason,
  DagCompletionGuardKind,
  DagDependencyMode,
  DagExecutorKind,
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagRunOutcomeResultTag,
  DagTransitionErrorTag,
  DagTransitionResultTag,
  DagTransitionType,
  DagValidationResultTag,
  createDagRunState,
  deriveDagRunOutcome,
  deriveDagSchedulingStep,
  getDagNodeState,
  getDagOutputReference,
  reduceDagRunState,
  validateDagDefinition,
  type DagDefinition,
  type DagNode,
  type DagNodeResult,
  type DagRunState,
  type DagTransition,
  type ValidatedDagDefinition,
} from "../index.js";

const executor = {
  kind: DagExecutorKind.Transform,
  key: "test",
  payload: undefined,
} as const;

function node(
  id: string,
  dependencies: DagNode["dependencies"] = [],
  completionGuard?: DagNode["completionGuard"],
): DagNode {
  return { id, executor, dependencies, ...(completionGuard ? { completionGuard } : {}) };
}

function graph(nodes: readonly DagNode[], concurrency = 4): ValidatedDagDefinition {
  const result = validateDagDefinition({ runId: "run-test", concurrency, nodes });
  expect(result._tag).toBe(DagValidationResultTag.Valid);
  if (result._tag !== DagValidationResultTag.Valid) throw new Error(JSON.stringify(result.errors));
  return result.graph;
}

type WithoutRunId<T> = T extends unknown ? Omit<T, "runId"> : never;

function apply(
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

function terminalResult(tag: DagNodeResult["_tag"]): DagNodeResult {
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

function finish(
  dag: ValidatedDagDefinition,
  state: DagRunState,
  nodeId: string,
  result: DagNodeResult,
): DagRunState {
  const running = apply(dag, state, { type: DagTransitionType.Start, nodeId });
  return apply(dag, running, { type: DagTransitionType.Complete, nodeId, result });
}

function status(dag: ValidatedDagDefinition, state: DagRunState, nodeId: string): DagNodeStatus {
  const value = getDagNodeState(dag, state, nodeId);
  if (!value) throw new Error(`Missing node ${nodeId}`);
  return value.status;
}

describe("DAG scheduling", () => {
  it("returns ready nodes in declaration order", () => {
    const dag = graph([node("zeta"), node("alpha"), node("middle")]);

    expect(deriveDagSchedulingStep(dag, createDagRunState(dag)).readyNodeIds).toEqual([
      "zeta",
      "alpha",
      "middle",
    ]);
  });

  it("limits ready nodes to available concurrency", () => {
    const dag = graph([node("first"), node("second"), node("third")], 2);
    const initial = createDagRunState(dag);
    expect(deriveDagSchedulingStep(dag, initial).readyNodeIds).toEqual(["first", "second"]);

    const running = apply(dag, initial, { type: DagTransitionType.Start, nodeId: "first" });
    expect(deriveDagSchedulingStep(dag, running).readyNodeIds).toEqual(["second"]);
  });

  it("blocks required descendants and continues an independent branch", () => {
    const dag = graph([
      node("grandchild", [{ nodeId: "child", mode: DagDependencyMode.Required }]),
      node("root"),
      node("child", [{ nodeId: "root", mode: DagDependencyMode.Required }]),
      node("independent"),
      node("independent-child", [{ nodeId: "independent", mode: DagDependencyMode.Required }]),
    ]);
    const failed = finish(
      dag,
      createDagRunState(dag),
      "root",
      terminalResult(DagNodeResultTag.Failed),
    );

    const step = deriveDagSchedulingStep(dag, failed);

    expect(status(dag, step.state, "child")).toBe(DagNodeStatus.Blocked);
    expect(status(dag, step.state, "grandchild")).toBe(DagNodeStatus.Blocked);
    expect(status(dag, step.state, "independent-child")).toBe(DagNodeStatus.Queued);
    expect(step.readyNodeIds).toEqual(["independent"]);
    expect(step.transitions.map((transition) => transition.nodeId)).toEqual([
      "child",
      "grandchild",
    ]);
  });

  it.each([
    DagNodeResultTag.Succeeded,
    DagNodeResultTag.Failed,
    DagNodeResultTag.Cancelled,
    DagNodeResultTag.Interrupted,
  ])("waits for a settled dependency and then accepts %s", (producerResult) => {
    const dag = graph([
      node("producer"),
      node("observer", [{ nodeId: "producer", mode: DagDependencyMode.Settled }]),
    ]);
    const initial = createDagRunState(dag);
    const running = apply(dag, initial, {
      type: DagTransitionType.Start,
      nodeId: "producer",
    });
    expect(deriveDagSchedulingStep(dag, running).readyNodeIds).toEqual([]);

    const settled = apply(dag, running, {
      type: DagTransitionType.Complete,
      nodeId: "producer",
      result: terminalResult(producerResult),
    });
    expect(deriveDagSchedulingStep(dag, settled).readyNodeIds).toEqual(["observer"]);
  });

  it("requires all guarded dependencies to settle and one to succeed", () => {
    const guard = {
      kind: DagCompletionGuardKind.AtLeastOneSucceeded,
      dependencyIds: ["review-a", "review-b"],
    } as const;
    const dag = graph([
      node("review-a"),
      node("review-b"),
      node(
        "synthesize",
        [
          { nodeId: "review-a", mode: DagDependencyMode.Settled },
          { nodeId: "review-b", mode: DagDependencyMode.Settled },
        ],
        guard,
      ),
    ]);
    const aFailed = finish(
      dag,
      createDagRunState(dag),
      "review-a",
      terminalResult(DagNodeResultTag.Failed),
    );
    expect(status(dag, deriveDagSchedulingStep(dag, aFailed).state, "synthesize")).toBe(
      DagNodeStatus.Queued,
    );

    const noneSucceeded = finish(
      dag,
      aFailed,
      "review-b",
      terminalResult(DagNodeResultTag.Interrupted),
    );
    expect(
      getDagNodeState(dag, deriveDagSchedulingStep(dag, noneSucceeded).state, "synthesize"),
    ).toMatchObject({
      status: DagNodeStatus.Blocked,
      reason: DagBlockedReason.CompletionGuard,
      blockedBy: ["review-a", "review-b"],
    });

    const oneSucceeded = finish(
      dag,
      aFailed,
      "review-b",
      terminalResult(DagNodeResultTag.Succeeded),
    );
    expect(deriveDagSchedulingStep(dag, oneSucceeded).readyNodeIds).toEqual(["synthesize"]);
  });
});

describe("DAG state reduction", () => {
  it("represents all seven node states", () => {
    const dag = graph([
      node("source"),
      node("dependent", [{ nodeId: "source", mode: DagDependencyMode.Required }]),
    ]);
    const statuses = new Set<DagNodeStatus>();
    const initial = createDagRunState(dag);
    statuses.add(status(dag, initial, "source"));
    const running = apply(dag, initial, { type: DagTransitionType.Start, nodeId: "source" });
    statuses.add(status(dag, running, "source"));
    for (const tag of Object.values(DagNodeResultTag)) {
      statuses.add(
        status(
          dag,
          apply(dag, running, {
            type: DagTransitionType.Complete,
            nodeId: "source",
            result: terminalResult(tag),
          }),
          "source",
        ),
      );
    }
    const failed = finish(dag, initial, "source", terminalResult(DagNodeResultTag.Failed));
    statuses.add(status(dag, deriveDagSchedulingStep(dag, failed).state, "dependent"));

    expect(statuses).toEqual(new Set(Object.values(DagNodeStatus)));
  });

  it("rejects starts before readiness and transitions from terminal states", () => {
    const dag = graph([
      node("source"),
      node("consumer", [{ nodeId: "source", mode: DagDependencyMode.Required }]),
    ]);
    const initial = createDagRunState(dag);
    expect(
      reduceDagRunState(dag, initial, {
        runId: dag.runId,
        type: DagTransitionType.Start,
        nodeId: "consumer",
      }),
    ).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.InvalidTransition },
    });

    const succeeded = finish(dag, initial, "source", terminalResult(DagNodeResultTag.Succeeded));
    expect(
      reduceDagRunState(dag, succeeded, {
        runId: dag.runId,
        type: DagTransitionType.Start,
        nodeId: "source",
      }),
    ).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: {
        from: DagNodeStatus.Succeeded,
        to: DagNodeStatus.Running,
      },
    });
  });

  it("rejects malformed results and canonicalizes accepted events", () => {
    const dag = graph([node("task")]);
    const initial = createDagRunState(dag);
    const started = reduceDagRunState(dag, initial, {
      runId: dag.runId,
      type: DagTransitionType.Start,
      nodeId: "task",
      unexpected: true,
    } as DagTransition & { unexpected: boolean });
    expect(started._tag).toBe(DagTransitionResultTag.Applied);
    if (started._tag !== DagTransitionResultTag.Applied) return;
    expect(started.transition).toEqual({
      runId: dag.runId,
      type: DagTransitionType.Start,
      nodeId: "task",
    });
    expect(Object.isFrozen(started.transition)).toBe(true);

    for (const result of [
      { _tag: "unknown" },
      { _tag: DagNodeResultTag.Succeeded, outputs: null },
      { _tag: DagNodeResultTag.Cancelled, reason: 42 },
    ]) {
      expect(
        reduceDagRunState(dag, started.state, {
          runId: dag.runId,
          type: DagTransitionType.Complete,
          nodeId: "task",
          result,
        } as unknown as DagTransition),
      ).toMatchObject({
        _tag: DagTransitionResultTag.Rejected,
        error: { _tag: DagTransitionErrorTag.MalformedTransition },
      });
    }
  });

  it("rejects incomplete block provenance", () => {
    const dag = graph([
      node("a"),
      node("b"),
      node("join", [
        { nodeId: "a", mode: DagDependencyMode.Required },
        { nodeId: "b", mode: DagDependencyMode.Required },
      ]),
    ]);
    const failed = finish(
      dag,
      finish(dag, createDagRunState(dag), "a", terminalResult(DagNodeResultTag.Failed)),
      "b",
      terminalResult(DagNodeResultTag.Failed),
    );

    expect(
      reduceDagRunState(dag, failed, {
        runId: dag.runId,
        type: DagTransitionType.Block,
        nodeId: "join",
        reason: DagBlockedReason.RequiredDependency,
        blockedBy: ["a"],
      }),
    ).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.InvalidBlock },
    });
  });

  it("stores generic outputs by node and output name", () => {
    const dag = graph([node("producer")]);
    const artifact = { kind: "managed-file", relativePath: "outputs/report.json" };
    const succeeded = finish(dag, createDagRunState(dag), "producer", {
      _tag: DagNodeResultTag.Succeeded,
      outputs: { report: artifact },
    });

    expect(getDagOutputReference(dag, succeeded, "producer", "report")).toBe(artifact);
    expect(getDagOutputReference(dag, succeeded, "producer", "missing")).toBeUndefined();
  });
});

describe("DAG terminal outcomes", () => {
  it("uses fixed precedence independent of completion order", () => {
    const dag = graph([node("first"), node("second")]);
    const initial = createDagRunState(dag);
    expect(deriveDagRunOutcome(dag, initial)).toEqual({
      _tag: DagRunOutcomeResultTag.NonTerminal,
      nodeIds: ["first", "second"],
    });

    const failedThenCancelled = finish(
      dag,
      finish(dag, initial, "first", terminalResult(DagNodeResultTag.Failed)),
      "second",
      terminalResult(DagNodeResultTag.Cancelled),
    );
    const cancelledThenFailed = finish(
      dag,
      finish(dag, initial, "second", terminalResult(DagNodeResultTag.Cancelled)),
      "first",
      terminalResult(DagNodeResultTag.Failed),
    );
    expect(deriveDagRunOutcome(dag, failedThenCancelled)).toEqual({
      _tag: DagRunOutcomeResultTag.Terminal,
      outcome: DagRunOutcome.Failed,
    });
    expect(deriveDagRunOutcome(dag, cancelledThenFailed)).toEqual(
      deriveDagRunOutcome(dag, failedThenCancelled),
    );
  });

  it.each([
    [DagNodeResultTag.Succeeded, DagRunOutcome.Succeeded],
    [DagNodeResultTag.Cancelled, DagRunOutcome.Cancelled],
    [DagNodeResultTag.Interrupted, DagRunOutcome.Interrupted],
    [DagNodeResultTag.Failed, DagRunOutcome.Failed],
  ] as const)("maps %s to run outcome %s", (tag, outcome) => {
    const dag = graph([node("task")]);
    const state = finish(dag, createDagRunState(dag), "task", terminalResult(tag));
    expect(deriveDagRunOutcome(dag, state)).toEqual({
      _tag: DagRunOutcomeResultTag.Terminal,
      outcome,
    });
  });
});
