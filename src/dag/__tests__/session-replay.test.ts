import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  DagBlockedReason,
  DagCompletionGuardKind,
  DagDependencyMode,
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionType,
  computeDagSessionGraphId,
  makeDagSessionWriter,
  reconstructDagSession,
  validateDagDefinition,
  type DagDefinition,
} from "../index.js";
import * as Fixtures from "./shared.js";

function node(
  id: string,
  dependencies: readonly { readonly nodeId: string; readonly mode: "required" | "settled" }[] = [],
  completionGuard?: {
    readonly kind: typeof DagCompletionGuardKind.AtLeastOneSucceeded;
    readonly dependencyIds: readonly string[];
  },
) {
  return {
    id,
    executor: { kind: "transform" as const, key: "test", payload: null },
    dependencies,
    ...(completionGuard ? { completionGuard } : {}),
  };
}

function valid(def: DagDefinition) {
  const result = validateDagDefinition(def);
  expect(result._tag).toBe("valid");
  if (result._tag !== "valid") throw new Error("invalid graph");
  return result.graph;
}

function failureTag(effect: Effect.Effect<unknown, { readonly _tag: string }>) {
  const option = Exit.findErrorOption(Effect.runSyncExit(effect));
  expect(Option.isSome(option)).toBe(true);
  return Option.isSome(option) ? option.value._tag : "";
}

describe("DAG session replay", () => {
  it("replays a valid terminal history through public writer and reconstruction", () => {
    const def = Fixtures.definition([node("a")], 1);
    const dag = valid(def);
    const store = Fixtures.sessionStore();
    const writer = makeDagSessionWriter(store, dag, def);

    Effect.runSync(writer.appendGraph(def));
    Effect.runSync(
      writer.appendTransition(
        { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
        { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Running },
      ),
    );
    Effect.runSync(
      writer.appendTransition(
        {
          runId: def.runId,
          nodeId: "a",
          type: DagTransitionType.Complete,
          result: { _tag: DagNodeResultTag.Succeeded, outputs: { value: 1 } },
        },
        { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Succeeded },
      ),
    );
    Effect.runSync(writer.appendFinal(DagRunOutcome.Succeeded));

    const recovered = Effect.runSync(reconstructDagSession(store, def.runId));
    expect(recovered.graphId).toBe(computeDagSessionGraphId(def));
    expect(recovered.terminalOutcome).toBe(DagRunOutcome.Succeeded);
    expect(Fixtures.status(recovered.graph, recovered.state, "a")).toBe(DagNodeStatus.Succeeded);
    expect(recovered.attempts[0]?.statuses).toEqual([
      DagNodeStatus.Running,
      DagNodeStatus.Succeeded,
    ]);
    expect(recovered.persistedEntryCount).toBe(4);
    expect(recovered.recoveredFromProcessLoss).toBe(false);
  });

  it("projects an open running prefix to interrupted without invoking work", () => {
    const def = Fixtures.definition([node("a")], 1);
    const dag = valid(def);
    const store = Fixtures.sessionStore();
    const writer = makeDagSessionWriter(store, dag, def);
    Effect.runSync(writer.appendGraph(def));
    Effect.runSync(
      writer.appendTransition(
        { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
        { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Running },
      ),
    );

    const recovered = Effect.runSync(reconstructDagSession(store, def.runId));
    expect(recovered.recoveredFromProcessLoss).toBe(true);
    expect(recovered.transitions.map((t) => t.type)).toEqual([
      DagTransitionType.Start,
      DagTransitionType.Complete,
    ]);
    expect(Fixtures.status(recovered.graph, recovered.state, "a")).toBe(DagNodeStatus.Interrupted);
    expect(recovered.terminalOutcome).toBe(DagRunOutcome.Interrupted);
    expect(recovered.attempts[0]?.statuses).toEqual([
      DagNodeStatus.Running,
      DagNodeStatus.Interrupted,
    ]);
  });

  it("projects queued process-loss prefixes with reducer-derived blocks before cancellations", () => {
    const def = Fixtures.definition(
      [node("a"), node("b", [{ nodeId: "a", mode: "required" }]), node("c")],
      1,
    );
    const dag = valid(def);
    const store = Fixtures.sessionStore();
    const writer = makeDagSessionWriter(store, dag, def);
    Effect.runSync(writer.appendGraph(def));
    Effect.runSync(
      writer.appendTransition(
        { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
        { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Running },
      ),
    );
    Effect.runSync(
      writer.appendTransition(
        {
          runId: def.runId,
          nodeId: "a",
          type: DagTransitionType.Complete,
          result: { _tag: DagNodeResultTag.Failed, failure: "boom" },
        },
        { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Failed },
      ),
    );

    const recovered = Effect.runSync(reconstructDagSession(store, def.runId));
    expect(Fixtures.status(recovered.graph, recovered.state, "b")).toBe(DagNodeStatus.Blocked);
    expect(Fixtures.status(recovered.graph, recovered.state, "c")).toBe(DagNodeStatus.Cancelled);
    expect(recovered.terminalOutcome).toBe(DagRunOutcome.Failed);
  });

  it("excludes sibling run entries and returns immutable data", () => {
    const def = Fixtures.definition([node("a")], 1);
    const dag = valid(def);
    const store = Fixtures.sessionStore([
      {
        v: 1,
        runId: "sibling",
        graphId: "x",
        seq: 0,
        event: { _tag: "graph", graph: { ...def, runId: "sibling" } },
      },
    ]);
    const writer = makeDagSessionWriter(store, dag, def);
    Effect.runSync(writer.appendGraph(def));

    const recovered = Effect.runSync(reconstructDagSession(store, def.runId));
    expect(recovered.persistedEntryCount).toBe(1);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(Object.isFrozen(recovered.transitions)).toBe(true);
    expect("cancel" in recovered).toBe(false);
    expect("await" in recovered).toBe(false);
  });

  it("projects settled dependencies and AtLeastOneSucceeded guards after restart", () => {
    const def = Fixtures.definition(
      [
        node("review-a"),
        node("review-b"),
        node(
          "synthesize",
          [
            { nodeId: "review-a", mode: DagDependencyMode.Settled },
            { nodeId: "review-b", mode: DagDependencyMode.Settled },
          ],
          {
            kind: DagCompletionGuardKind.AtLeastOneSucceeded,
            dependencyIds: ["review-a", "review-b"],
          },
        ),
      ],
      2,
    );
    const dag = valid(def);
    const store = Fixtures.sessionStore();
    const writer = makeDagSessionWriter(store, dag, def);
    Effect.runSync(writer.appendGraph(def));
    for (const id of ["review-a", "review-b"] as const) {
      Effect.runSync(
        writer.appendTransition(
          { runId: def.runId, nodeId: id, type: DagTransitionType.Start },
          {
            nodeId: id,
            attemptId: `${def.runId}:${id}:1`,
            ordinal: 1,
            status: DagNodeStatus.Running,
          },
        ),
      );
      Effect.runSync(
        writer.appendTransition(
          {
            runId: def.runId,
            nodeId: id,
            type: DagTransitionType.Complete,
            result: { _tag: DagNodeResultTag.Failed, failure: id },
          },
          {
            nodeId: id,
            attemptId: `${def.runId}:${id}:1`,
            ordinal: 1,
            status: DagNodeStatus.Failed,
          },
        ),
      );
    }

    const recovered = Effect.runSync(reconstructDagSession(store, def.runId));
    expect(Fixtures.status(recovered.graph, recovered.state, "synthesize")).toBe(DagNodeStatus.Blocked);
    expect(recovered.state.nodes[2]).toEqual({
      nodeId: "synthesize",
      status: DagNodeStatus.Blocked,
      reason: DagBlockedReason.CompletionGuard,
      blockedBy: ["review-a", "review-b"],
    });
    expect(recovered.terminalOutcome).toBe(DagRunOutcome.Failed);
  });
});
