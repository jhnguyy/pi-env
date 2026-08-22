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
import * as Fixtures from "./shared.js";

describe("DAG scheduling", () => {
  it("returns ready nodes in declaration order", () => {
    const dag = Fixtures.graph([Fixtures.node("zeta"), Fixtures.node("alpha"), Fixtures.node("middle")]);
    expect(deriveDagSchedulingStep(dag, createDagRunState(dag)).readyNodeIds).toEqual([
      "zeta",
      "alpha",
      "middle",
    ]);
  });

  it("limits ready nodes to available concurrency", () => {
    const dag = Fixtures.graph([Fixtures.node("first"), Fixtures.node("second"), Fixtures.node("third")], 2);
    const initial = createDagRunState(dag);
    expect(deriveDagSchedulingStep(dag, initial).readyNodeIds).toEqual(["first", "second"]);
    const running = Fixtures.apply(dag, initial, { type: DagTransitionType.Start, nodeId: "first" });
    expect(deriveDagSchedulingStep(dag, running).readyNodeIds).toEqual(["second"]);
    const completed = Fixtures.apply(dag, running, {
      type: DagTransitionType.Complete,
      nodeId: "first",
      result: Fixtures.terminalResult(DagNodeResultTag.Succeeded),
    });
    expect(deriveDagSchedulingStep(dag, completed).readyNodeIds).toEqual(["second", "third"]);
  });

  it("blocks required descendants and continues an independent branch", () => {
    const dag = Fixtures.graph([
      Fixtures.node("grandchild", [{ nodeId: "child", mode: DagDependencyMode.Required }]),
      Fixtures.node("root"),
      Fixtures.node("child", [{ nodeId: "root", mode: DagDependencyMode.Required }]),
      Fixtures.node("independent"),
      Fixtures.node("independent-child", [{ nodeId: "independent", mode: DagDependencyMode.Required }]),
    ]);
    const failed = Fixtures.finish(
      dag,
      createDagRunState(dag),
      "root",
      Fixtures.terminalResult(DagNodeResultTag.Failed),
    );
    const step = deriveDagSchedulingStep(dag, failed);
    expect(Fixtures.status(dag, step.state, "child")).toBe(DagNodeStatus.Blocked);
    expect(Fixtures.status(dag, step.state, "grandchild")).toBe(DagNodeStatus.Blocked);
    expect(Fixtures.status(dag, step.state, "independent-child")).toBe(DagNodeStatus.Queued);
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
    const dag = Fixtures.graph([
      Fixtures.node("producer"),
      Fixtures.node("observer", [{ nodeId: "producer", mode: DagDependencyMode.Settled }]),
    ]);
    const initial = createDagRunState(dag);
    const running = Fixtures.apply(dag, initial, { type: DagTransitionType.Start, nodeId: "producer" });
    expect(deriveDagSchedulingStep(dag, running).readyNodeIds).toEqual([]);
    const settled = Fixtures.apply(dag, running, {
      type: DagTransitionType.Complete,
      nodeId: "producer",
      result: Fixtures.terminalResult(producerResult),
    });
    expect(deriveDagSchedulingStep(dag, settled).readyNodeIds).toEqual(["observer"]);
  });

  it("requires all guarded dependencies to settle and one to succeed", () => {
    const guard = {
      kind: DagCompletionGuardKind.AtLeastOneSucceeded,
      dependencyIds: ["review-a", "review-b"],
    } as const;
    const dag = Fixtures.graph([
      Fixtures.node("review-a"),
      Fixtures.node("review-b"),
      Fixtures.node(
        "synthesize",
        [
          { nodeId: "review-a", mode: DagDependencyMode.Settled },
          { nodeId: "review-b", mode: DagDependencyMode.Settled },
        ],
        guard,
      ),
    ]);
    const aFailed = Fixtures.finish(
      dag,
      createDagRunState(dag),
      "review-a",
      Fixtures.terminalResult(DagNodeResultTag.Failed),
    );
    expect(Fixtures.status(dag, deriveDagSchedulingStep(dag, aFailed).state, "synthesize")).toBe(
      DagNodeStatus.Queued,
    );
    const noneSucceeded = Fixtures.finish(
      dag,
      aFailed,
      "review-b",
      Fixtures.terminalResult(DagNodeResultTag.Interrupted),
    );
    expect(
      getDagNodeState(dag, deriveDagSchedulingStep(dag, noneSucceeded).state, "synthesize"),
    ).toMatchObject({
      status: DagNodeStatus.Blocked,
      reason: DagBlockedReason.CompletionGuard,
      blockedBy: ["review-a", "review-b"],
    });
    const oneSucceeded = Fixtures.finish(
      dag,
      aFailed,
      "review-b",
      Fixtures.terminalResult(DagNodeResultTag.Succeeded),
    );
    expect(deriveDagSchedulingStep(dag, oneSucceeded).readyNodeIds).toEqual(["synthesize"]);
  });
});
