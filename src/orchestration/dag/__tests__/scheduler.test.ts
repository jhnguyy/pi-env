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
  type DagNamedOutputs,
  type DagNodeResult,
  type DagOutputReference,
  type DagRunState,
  type DagTransition,
  type ValidatedDagDefinition,
} from "../index.js";

const executor = {
  kind: DagExecutorKind.Transform,
  key: "test",
  payload: undefined,
} as const;

type WithoutRunId<T> = T extends unknown ? Omit<T, "runId"> : never;

function graph(nodes: DagDefinition["nodes"], concurrency = 4): ValidatedDagDefinition {
  const result = validateDagDefinition({ runId: "run-test", concurrency, nodes });
  expect(result._tag).toBe(DagValidationResultTag.Valid);
  if (result._tag !== DagValidationResultTag.Valid) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.graph;
}

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
  if (result._tag !== DagTransitionResultTag.Applied) {
    throw new Error(JSON.stringify(result.error));
  }
  return result.state;
}

function result(_tag: DagNodeResult["_tag"]): DagNodeResult {
  switch (_tag) {
    case DagNodeResultTag.Succeeded:
      return { _tag, outputs: {} };
    case DagNodeResultTag.Failed:
      return { _tag, failure: { code: "TEST_FAILURE", message: "failed" } };
    case DagNodeResultTag.Cancelled:
      return { _tag, reason: "cancelled by test" };
    case DagNodeResultTag.Interrupted:
      return { _tag, reason: "interrupted by test" };
  }
}

function finish(
  dag: ValidatedDagDefinition,
  state: DagRunState,
  nodeId: string,
  nodeResult: DagNodeResult,
): DagRunState {
  const running = apply(dag, state, { type: DagTransitionType.Start, nodeId });
  return apply(dag, running, {
    type: DagTransitionType.Complete,
    nodeId,
    result: nodeResult,
  });
}

function status(state: DagRunState, nodeId: string): DagNodeStatus {
  const node = getDagNodeState(state, nodeId);
  if (!node) throw new Error(`Missing node ${nodeId}`);
  return node.status;
}

describe("DAG readiness and blocking", () => {
  it("returns ready nodes in static declaration order", () => {
    const dag = graph([
      { id: "zeta", executor, dependencies: [] },
      { id: "alpha", executor, dependencies: [] },
      { id: "middle", executor, dependencies: [] },
    ]);

    expect(deriveDagSchedulingStep(dag, createDagRunState(dag)).readyNodeIds).toEqual([
      "zeta",
      "alpha",
      "middle",
    ]);
  });

  it("limits ready nodes to available concurrency slots", () => {
    const dag = graph(
      [
        { id: "first", executor, dependencies: [] },
        { id: "second", executor, dependencies: [] },
        { id: "third", executor, dependencies: [] },
      ],
      2,
    );
    const initial = createDagRunState(dag);

    expect(deriveDagSchedulingStep(dag, initial).readyNodeIds).toEqual(["first", "second"]);
    const oneRunning = apply(dag, initial, {
      type: DagTransitionType.Start,
      nodeId: "first",
    });
    expect(deriveDagSchedulingStep(dag, oneRunning).readyNodeIds).toEqual(["second"]);
  });

  it("blocks required descendants and keeps an independent branch ready", () => {
    const dag = graph([
      {
        id: "grandchild",
        executor,
        dependencies: [{ nodeId: "child", mode: DagDependencyMode.Required }],
      },
      { id: "root", executor, dependencies: [] },
      {
        id: "child",
        executor,
        dependencies: [{ nodeId: "root", mode: DagDependencyMode.Required }],
      },
      { id: "independent", executor, dependencies: [] },
      {
        id: "independent-child",
        executor,
        dependencies: [{ nodeId: "independent", mode: DagDependencyMode.Required }],
      },
    ]);
    const failed = finish(dag, createDagRunState(dag), "root", result(DagNodeResultTag.Failed));

    const step = deriveDagSchedulingStep(dag, failed);

    expect(status(step.state, "child")).toBe(DagNodeStatus.Blocked);
    expect(status(step.state, "grandchild")).toBe(DagNodeStatus.Blocked);
    expect(step.readyNodeIds).toEqual(["independent"]);
    expect(step.transitions.map((transition) => transition.nodeId)).toEqual([
      "child",
      "grandchild",
    ]);
    expect(getDagNodeState(step.state, "child")).toMatchObject({
      status: DagNodeStatus.Blocked,
      reason: DagBlockedReason.RequiredDependency,
      blockedBy: ["root"],
    });
    expect(status(step.state, "independent-child")).toBe(DagNodeStatus.Queued);
  });

  it.each([
    DagNodeResultTag.Succeeded,
    DagNodeResultTag.Failed,
    DagNodeResultTag.Cancelled,
    DagNodeResultTag.Interrupted,
  ])("waits for a settled dependency and then accepts %s", (producerResult) => {
    const dag = graph([
      { id: "producer", executor, dependencies: [] },
      {
        id: "observer",
        executor,
        dependencies: [{ nodeId: "producer", mode: DagDependencyMode.Settled }],
      },
    ]);
    const initial = createDagRunState(dag);
    const running = apply(dag, initial, {
      type: DagTransitionType.Start,
      nodeId: "producer",
    });

    expect(deriveDagSchedulingStep(dag, running).readyNodeIds).toEqual([]);

    const terminal = apply(dag, running, {
      type: DagTransitionType.Complete,
      nodeId: "producer",
      result: result(producerResult),
    });
    expect(deriveDagSchedulingStep(dag, terminal).readyNodeIds).toEqual(["observer"]);
  });

  it("requires all guarded dependencies to settle and at least one to succeed", () => {
    const dag = graph([
      { id: "review-a", executor, dependencies: [] },
      { id: "review-b", executor, dependencies: [] },
      {
        id: "synthesize",
        executor,
        dependencies: [
          { nodeId: "review-a", mode: DagDependencyMode.Settled },
          { nodeId: "review-b", mode: DagDependencyMode.Settled },
        ],
        completionGuard: {
          kind: DagCompletionGuardKind.AtLeastOneSucceeded,
          dependencyIds: ["review-a", "review-b"],
        },
      },
    ]);
    const aFailed = finish(
      dag,
      createDagRunState(dag),
      "review-a",
      result(DagNodeResultTag.Failed),
    );
    expect(status(deriveDagSchedulingStep(dag, aFailed).state, "synthesize")).toBe(
      DagNodeStatus.Queued,
    );

    const noneSucceeded = finish(dag, aFailed, "review-b", result(DagNodeResultTag.Interrupted));
    const blocked = deriveDagSchedulingStep(dag, noneSucceeded);
    expect(getDagNodeState(blocked.state, "synthesize")).toMatchObject({
      status: DagNodeStatus.Blocked,
      reason: DagBlockedReason.CompletionGuard,
      blockedBy: ["review-a", "review-b"],
    });

    const bSucceeded = finish(dag, aFailed, "review-b", result(DagNodeResultTag.Succeeded));
    expect(deriveDagSchedulingStep(dag, bSucceeded).readyNodeIds).toEqual(["synthesize"]);
  });
});

describe("DAG state reduction", () => {
  it("represents every explicit node state through valid transitions", () => {
    const source = { id: "source", executor, dependencies: [] } as const;
    const dependent = {
      id: "dependent",
      executor,
      dependencies: [{ nodeId: "source", mode: DagDependencyMode.Required }],
    } as const;
    const statuses = new Set<DagNodeStatus>();

    const single = graph([source]);
    const queued = createDagRunState(single);
    statuses.add(status(queued, "source"));
    const running = apply(single, queued, {
      type: DagTransitionType.Start,
      nodeId: "source",
    });
    statuses.add(status(running, "source"));
    for (const terminalResult of [
      DagNodeResultTag.Succeeded,
      DagNodeResultTag.Failed,
      DagNodeResultTag.Cancelled,
      DagNodeResultTag.Interrupted,
    ] as const) {
      const terminal = apply(single, running, {
        type: DagTransitionType.Complete,
        nodeId: "source",
        result: result(terminalResult),
      });
      statuses.add(status(terminal, "source"));
    }

    const blockedDag = graph([source, dependent]);
    const sourceFailed = finish(
      blockedDag,
      createDagRunState(blockedDag),
      "source",
      result(DagNodeResultTag.Failed),
    );
    statuses.add(status(deriveDagSchedulingStep(blockedDag, sourceFailed).state, "dependent"));

    expect(statuses).toEqual(
      new Set([
        DagNodeStatus.Queued,
        DagNodeStatus.Running,
        DagNodeStatus.Succeeded,
        DagNodeStatus.Failed,
        DagNodeStatus.Blocked,
        DagNodeStatus.Cancelled,
        DagNodeStatus.Interrupted,
      ]),
    );
  });

  it("rejects starts before dependency readiness", () => {
    const dag = graph([
      { id: "source", executor, dependencies: [] },
      {
        id: "consumer",
        executor,
        dependencies: [{ nodeId: "source", mode: DagDependencyMode.Required }],
      },
    ]);

    const rejected = reduceDagRunState(dag, createDagRunState(dag), {
      runId: dag.runId,
      type: DagTransitionType.Start,
      nodeId: "consumer",
    });

    expect(rejected).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: {
        _tag: DagTransitionErrorTag.InvalidTransition,
        from: DagNodeStatus.Queued,
        to: DagNodeStatus.Running,
      },
    });
  });

  it("canonicalizes accepted transitions to their declared event fields", () => {
    const dag = graph([{ id: "task", executor, dependencies: [] }]);
    const transition = {
      runId: dag.runId,
      type: DagTransitionType.Start,
      nodeId: "task",
      unexpected: { mutable: true },
    } as unknown as DagTransition;

    const applied = reduceDagRunState(dag, createDagRunState(dag), transition);

    expect(applied).toMatchObject({ _tag: DagTransitionResultTag.Applied });
    if (applied._tag === DagTransitionResultTag.Applied) {
      expect(applied.transition).toEqual({
        runId: dag.runId,
        type: DagTransitionType.Start,
        nodeId: "task",
      });
      expect(Object.isFrozen(applied.transition)).toBe(true);
    }
  });

  it("removes undeclared failure fields from accepted events", () => {
    const dag = graph([{ id: "task", executor, dependencies: [] }]);
    const running = apply(dag, createDagRunState(dag), {
      type: DagTransitionType.Start,
      nodeId: "task",
    });
    const transition = {
      runId: dag.runId,
      type: DagTransitionType.Complete,
      nodeId: "task",
      result: {
        _tag: DagNodeResultTag.Failed,
        failure: { code: "TEST_FAILURE", message: "failed", secret: "remove" },
      },
    } as unknown as DagTransition;

    const applied = reduceDagRunState(dag, running, transition);

    expect(applied).toMatchObject({ _tag: DagTransitionResultTag.Applied });
    if (applied._tag === DagTransitionResultTag.Applied) {
      expect(applied.transition).toEqual({
        runId: dag.runId,
        type: DagTransitionType.Complete,
        nodeId: "task",
        result: {
          _tag: DagNodeResultTag.Failed,
          failure: { code: "TEST_FAILURE", message: "failed" },
        },
      });
    }
  });

  it("rejects malformed completion results without corrupting state", () => {
    const dag = graph([{ id: "task", executor, dependencies: [] }]);
    const running = apply(dag, createDagRunState(dag), {
      type: DagTransitionType.Start,
      nodeId: "task",
    });
    const malformed = {
      runId: dag.runId,
      type: DagTransitionType.Complete,
      nodeId: "task",
      result: { _tag: "unknown-result" },
    } as unknown as DagTransition;

    expect(reduceDagRunState(dag, running, malformed)).toEqual({
      _tag: DagTransitionResultTag.Rejected,
      error: {
        _tag: DagTransitionErrorTag.MalformedTransition,
        nodeId: "task",
      },
    });
    expect(status(running, "task")).toBe(DagNodeStatus.Running);
  });

  it("rejects incomplete required-block provenance", () => {
    const dag = graph([
      { id: "source-a", executor, dependencies: [] },
      { id: "source-b", executor, dependencies: [] },
      {
        id: "consumer",
        executor,
        dependencies: [
          { nodeId: "source-a", mode: DagDependencyMode.Required },
          { nodeId: "source-b", mode: DagDependencyMode.Required },
        ],
      },
    ]);
    const failed = finish(
      dag,
      finish(dag, createDagRunState(dag), "source-a", result(DagNodeResultTag.Failed)),
      "source-b",
      result(DagNodeResultTag.Failed),
    );

    expect(
      reduceDagRunState(dag, failed, {
        runId: dag.runId,
        type: DagTransitionType.Block,
        nodeId: "consumer",
        reason: DagBlockedReason.RequiredDependency,
        blockedBy: ["source-a"],
      }),
    ).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: { _tag: DagTransitionErrorTag.InvalidBlock },
    });
  });

  it("rejects transitions that skip running or leave a terminal state", () => {
    const dag = graph([{ id: "task", executor, dependencies: [] }]);
    const queued = createDagRunState(dag);
    const skippedRunning = reduceDagRunState(dag, queued, {
      runId: dag.runId,
      type: DagTransitionType.Complete,
      nodeId: "task",
      result: result(DagNodeResultTag.Succeeded),
    });
    expect(skippedRunning).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: {
        nodeId: "task",
        from: DagNodeStatus.Queued,
        to: DagNodeStatus.Succeeded,
      },
    });

    const succeeded = finish(dag, queued, "task", result(DagNodeResultTag.Succeeded));
    const restarted = reduceDagRunState(dag, succeeded, {
      runId: dag.runId,
      type: DagTransitionType.Start,
      nodeId: "task",
    });
    expect(restarted).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: {
        nodeId: "task",
        from: DagNodeStatus.Succeeded,
        to: DagNodeStatus.Running,
      },
    });
  });

  it("stores and resolves generic outputs by node and output name", () => {
    const dag = graph([{ id: "producer", executor, dependencies: [] }]);
    const artifact: DagOutputReference<{ readonly relativePath: string }> = {
      kind: "managed-file",
      locator: { relativePath: "outputs/report.json" },
    };
    const outputs: DagNamedOutputs<typeof artifact> = { report: artifact };
    const succeeded = finish(dag, createDagRunState(dag), "producer", {
      _tag: DagNodeResultTag.Succeeded,
      outputs,
      summary: "One bounded output reference.",
    });

    expect(getDagOutputReference(succeeded, "producer", "report")).toBe(artifact);
    expect(getDagOutputReference(succeeded, "producer", "missing")).toBeUndefined();
  });
});

describe("DAG terminal outcomes", () => {
  it("uses a fixed outcome precedence independent of completion order", () => {
    const dag = graph([
      { id: "first", executor, dependencies: [] },
      { id: "second", executor, dependencies: [] },
    ]);
    const initial = createDagRunState(dag);
    expect(deriveDagRunOutcome(dag, initial)).toMatchObject({
      _tag: DagRunOutcomeResultTag.NonTerminal,
      nodeIds: ["first", "second"],
    });
    const forged = {
      ...initial,
      nodes: initial.nodes.map((node) => ({
        nodeId: node.nodeId,
        status: DagNodeStatus.Succeeded,
        outputs: {},
      })),
    } as unknown as DagRunState;
    expect(deriveDagRunOutcome(dag, forged)).toMatchObject({
      _tag: DagRunOutcomeResultTag.NonTerminal,
      nodeIds: ["first", "second"],
    });

    const failedThenCancelled = finish(
      dag,
      finish(dag, initial, "first", result(DagNodeResultTag.Failed)),
      "second",
      result(DagNodeResultTag.Cancelled),
    );
    const cancelledThenFailed = finish(
      dag,
      finish(dag, initial, "second", result(DagNodeResultTag.Cancelled)),
      "first",
      result(DagNodeResultTag.Failed),
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
  ] as const)("maps terminal node result %s to run outcome %s", (nodeResult, outcome) => {
    const dag = graph([{ id: "task", executor, dependencies: [] }]);
    const terminal = finish(dag, createDagRunState(dag), "task", result(nodeResult));

    expect(deriveDagRunOutcome(dag, terminal)).toEqual({
      _tag: DagRunOutcomeResultTag.Terminal,
      outcome,
    });
  });
});
