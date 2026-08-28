import { describe, expect, it } from "vitest";
import {
  DagBlockedReason,
  DagDependencyMode,
  DagNodeResultTag,
  DagNodeStatus,
  DagTransitionErrorTag,
  DagTransitionResultTag,
  DagTransitionType,
  createDagRunState,
  getDagNodeState,
  getDagOutputReference,
  reduceDagRunState,
  type DagTransition,
} from "../index.js";
import * as Fixtures from "./shared.js";

describe("DAG state reduction", () => {
  it("rejects starts before readiness and transitions from terminal states", () => {
    const dag = Fixtures.graph([
      Fixtures.node("source"),
      Fixtures.node("consumer", [{ nodeId: "source", mode: DagDependencyMode.Required }]),
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
    const succeeded = Fixtures.finish(dag, initial, "source", Fixtures.terminalResult(DagNodeResultTag.Succeeded));
    expect(
      reduceDagRunState(dag, succeeded, {
        runId: dag.runId,
        type: DagTransitionType.Start,
        nodeId: "source",
      }),
    ).toMatchObject({
      _tag: DagTransitionResultTag.Rejected,
      error: { from: DagNodeStatus.Succeeded, to: DagNodeStatus.Running },
    });
  });

  it("rejects malformed results and canonicalizes accepted events", () => {
    const dag = Fixtures.graph([Fixtures.node("task")]);
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
    const dag = Fixtures.graph([
      Fixtures.node("a"),
      Fixtures.node("b"),
      Fixtures.node("join", [
        { nodeId: "a", mode: DagDependencyMode.Required },
        { nodeId: "b", mode: DagDependencyMode.Required },
      ]),
    ]);
    const failed = Fixtures.finish(
      dag,
      Fixtures.finish(dag, createDagRunState(dag), "a", Fixtures.terminalResult(DagNodeResultTag.Failed)),
      "b",
      Fixtures.terminalResult(DagNodeResultTag.Failed),
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
    const dag = Fixtures.graph([Fixtures.node("producer")]);
    const artifact = { kind: "managed-file", relativePath: "outputs/report.json" };
    const succeeded = Fixtures.finish(dag, createDagRunState(dag), "producer", {
      _tag: DagNodeResultTag.Succeeded,
      outputs: { report: artifact },
    });
    expect(getDagOutputReference(dag, succeeded, "producer", "report")).toBe(artifact);
    expect(getDagOutputReference(dag, succeeded, "producer", "missing")).toBeUndefined();
  });
});
