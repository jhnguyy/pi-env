import { describe, expect, it } from "vitest";
import {
  DagBlockedReason,
  DagCompletionGuardKind,
  DagDependencyMode,
  DagNodeResultTag,
  DagNodeStatus,
  DagTransitionResultTag,
  DagTransitionType,
  createDagRunState,
  deriveDagSchedulingStep,
  getDagNodeState,
  reduceDagRunState,
} from "../index.js";
import { apply, finish, graph, node, status, terminalResult } from "./shared.js";

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
    const completed = apply(dag, running, {
      type: DagTransitionType.Complete,
      nodeId: "first",
      result: terminalResult(DagNodeResultTag.Succeeded),
    });
    expect(deriveDagSchedulingStep(dag, completed).readyNodeIds).toEqual(["second", "third"]);
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

    let replayed = failed;
    for (const transition of step.transitions) {
      const result = reduceDagRunState(dag, replayed, transition);
      expect(result._tag).toBe(DagTransitionResultTag.Applied);
      if (result._tag !== DagTransitionResultTag.Applied) return;
      replayed = result.state;
    }
    expect(replayed.nodes).toEqual(step.state.nodes);
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
    const running = apply(dag, initial, { type: DagTransitionType.Start, nodeId: "producer" });
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
