import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  DagBlockedReason,
  DagCompletionGuardKind,
  DagDependencyMode,
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagSessionEntryType,
  DagTransitionType,
  computeDagSessionGraphId,
  createDagRunState,
  makeDagSessionWriter,
  reconstructDagSession,
  validateDagDefinition,
  type DagDefinition,
  type DagSessionEntry,
  type DagSessionManagerSeam,
} from "../index.js";
import { definition, status } from "./shared.js";

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

function seam(entries: unknown[] = []): DagSessionManagerSeam & { readonly entries: unknown[] } {
  return {
    entries,
    getBranch: () => [...entries],
    appendCustomEntry: (customType, data) => {
      entries.push({ type: "custom", customType, data });
      return String(entries.length);
    },
  };
}

function valid(def: DagDefinition) {
  const result = validateDagDefinition(def);
  expect(result._tag).toBe("valid");
  if (result._tag !== "valid") throw new Error("invalid graph");
  return result.graph;
}

function wrapper(data: DagSessionEntry) {
  return { type: "custom", customType: DagSessionEntryType, data };
}

function failureTag(effect: Effect.Effect<unknown, { readonly _tag: string }>) {
  const option = Exit.findErrorOption(Effect.runSyncExit(effect));
  expect(Option.isSome(option)).toBe(true);
  return Option.isSome(option) ? option.value._tag : "";
}

describe("DAG session persistence", () => {
  it("replays a valid terminal history through public writer and reconstruction", () => {
    const def = definition([node("a")], 1);
    const dag = valid(def);
    const store = seam();
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
    expect(status(recovered.graph, recovered.state, "a")).toBe(DagNodeStatus.Succeeded);
    expect(recovered.attempts[0]?.statuses).toEqual([
      DagNodeStatus.Running,
      DagNodeStatus.Succeeded,
    ]);
    expect(recovered.persistedEntryCount).toBe(4);
    expect(recovered.recoveredFromProcessLoss).toBe(false);
  });

  it("projects an open running prefix to interrupted without invoking work", () => {
    const def = definition([node("a")], 1);
    const dag = valid(def);
    const store = seam();
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
    expect(status(recovered.graph, recovered.state, "a")).toBe(DagNodeStatus.Interrupted);
    expect(recovered.terminalOutcome).toBe(DagRunOutcome.Interrupted);
    expect(recovered.attempts[0]?.statuses).toEqual([
      DagNodeStatus.Running,
      DagNodeStatus.Interrupted,
    ]);
  });

  it("projects queued process-loss prefixes with reducer-derived blocks before cancellations", () => {
    const def = definition(
      [node("a"), node("b", [{ nodeId: "a", mode: "required" }]), node("c")],
      1,
    );
    const dag = valid(def);
    const store = seam();
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
    expect(status(recovered.graph, recovered.state, "b")).toBe(DagNodeStatus.Blocked);
    expect(status(recovered.graph, recovered.state, "c")).toBe(DagNodeStatus.Cancelled);
    expect(recovered.terminalOutcome).toBe(DagRunOutcome.Failed);
  });

  it("rejects malformed ordering, duplicate, truncated, reducer, version, and limit histories", () => {
    const def = definition([node("a")], 1);
    const graphId = computeDagSessionGraphId(def);
    const graphEntry: DagSessionEntry = {
      v: 1,
      runId: def.runId,
      graphId,
      seq: 0,
      event: { _tag: "graph", graph: def },
    };

    expect(() =>
      Effect.runSync(
        reconstructDagSession(
          seam([
            { type: "custom", customType: DagSessionEntryType, data: { ...graphEntry, v: 2 } },
          ]),
          def.runId,
        ),
      ),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        reconstructDagSession(
          seam([
            { type: "custom", customType: DagSessionEntryType, data: { ...graphEntry, seq: 1 } },
          ]),
          def.runId,
        ),
      ),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        reconstructDagSession(
          seam([
            { type: "custom", customType: DagSessionEntryType, data: graphEntry },
            { type: "custom", customType: DagSessionEntryType, data: { ...graphEntry, seq: 0 } },
          ]),
          def.runId,
        ),
      ),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        reconstructDagSession(
          seam([
            { type: "custom", customType: DagSessionEntryType, data: graphEntry },
            {
              type: "custom",
              customType: DagSessionEntryType,
              data: {
                ...graphEntry,
                seq: 1,
                event: {
                  _tag: "transition",
                  transition: {
                    runId: def.runId,
                    nodeId: "a",
                    type: DagTransitionType.Complete,
                    result: { _tag: DagNodeResultTag.Succeeded, outputs: {} },
                  },
                },
              },
            },
          ]),
          def.runId,
        ),
      ),
    ).toThrow();
    expect(() =>
      Effect.runSync(
        reconstructDagSession(
          seam([{ type: "custom", customType: DagSessionEntryType, data: graphEntry }]),
          def.runId,
          { limits: { graphBytes: 8 } },
        ),
      ),
    ).toThrow();
    expect(
      failureTag(
        reconstructDagSession(
          seam([wrapper(graphEntry), wrapper({ ...graphEntry, v: 2 as never, seq: 1 })]),
          def.runId,
          { limits: { totalMatchingEntries: 1 } },
        ),
      ),
    ).toBe("limit");
  });

  it("uses only getBranch, excludes sibling branch entries, and returns immutable data", () => {
    const def = definition([node("a")], 1);
    const dag = valid(def);
    const store = seam([
      {
        type: "custom",
        customType: DagSessionEntryType,
        data: {
          v: 1,
          runId: "sibling",
          graphId: "x",
          seq: 0,
          event: { _tag: "graph", graph: { ...def, runId: "sibling" } },
        },
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

  it("matches live K3 snapshot transition and attempt history shape", () => {
    const def = definition([node("a")], 1);
    const dag = valid(def);
    const state0 = createDagRunState(dag);
    expect(state0.nodes[0]?.status).toBe(DagNodeStatus.Queued);
    const store = seam();
    const writer = makeDagSessionWriter(store, dag, def);
    Effect.runSync(writer.appendGraph(def));
    Effect.runSync(
      writer.appendTransition(
        { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
        { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Running },
      ),
    );
    const recovered = Effect.runSync(reconstructDagSession(store, def.runId));
    expect(recovered.transitions).toMatchObject([
      { type: DagTransitionType.Start, nodeId: "a" },
      { type: DagTransitionType.Complete, nodeId: "a" },
    ]);
    expect(recovered.attempts).toMatchObject([
      { nodeId: "a", ordinal: 1, statuses: [DagNodeStatus.Running, DagNodeStatus.Interrupted] },
    ]);
  });

  it("does not advance writer sequence or state when append fails", () => {
    const def = definition([node("a")], 1);
    const dag = valid(def);
    let fail = true;
    const entries: unknown[] = [];
    const store: DagSessionManagerSeam = {
      getBranch: () => entries,
      appendCustomEntry: (customType, data) => {
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
        entries.push({ type: "custom", customType, data });
        return "ok";
      },
    };
    const writer = makeDagSessionWriter(store, dag, def);

    expect(failureTag(writer.appendGraph(def))).toBe("malformed");
    Effect.runSync(writer.appendGraph(def));
    expect(Effect.runSync(reconstructDagSession(store, def.runId)).persistedEntryCount).toBe(1);

    const mismatchedDefinition = definition([node("other")], 1);
    const mismatchWriter = makeDagSessionWriter(seam(), dag, mismatchedDefinition);
    expect(failureTag(mismatchWriter.appendGraph(mismatchedDefinition))).toBe("graph-mismatch");

    const boundedStore = seam();
    const boundedWriter = makeDagSessionWriter(boundedStore, dag, def, {
      limits: { totalMatchingEntries: 1 },
    });
    Effect.runSync(boundedWriter.appendGraph(def));
    expect(
      failureTag(
        boundedWriter.appendTransition(
          { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
          {
            nodeId: "a",
            attemptId: `${def.runId}:a:1`,
            ordinal: 1,
            status: DagNodeStatus.Running,
          },
        ),
      ),
    ).toBe("limit");
  });

  it("rejects wrong-run transitions, malformed wire payloads, repeated graphs, projection limits, and inconsistent finals with typed tags", () => {
    const def = definition([node("a")], 1);
    const graphId = computeDagSessionGraphId(def);
    const graphEntry: DagSessionEntry = {
      v: 1,
      runId: def.runId,
      graphId,
      seq: 0,
      event: { _tag: "graph", graph: def },
    };
    const wrongRun: DagSessionEntry = {
      v: 1,
      runId: def.runId,
      graphId,
      seq: 1,
      event: {
        _tag: "transition",
        transition: { runId: "wrong", nodeId: "a", type: DagTransitionType.Start },
        attempt: {
          nodeId: "a",
          attemptId: `${def.runId}:a:1`,
          ordinal: 1,
          status: DagNodeStatus.Running,
        },
      },
    };
    const start: DagSessionEntry = {
      v: 1,
      runId: def.runId,
      graphId,
      seq: 1,
      event: {
        _tag: "transition",
        transition: { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
        attempt: {
          nodeId: "a",
          attemptId: `${def.runId}:a:1`,
          ordinal: 1,
          status: DagNodeStatus.Running,
        },
      },
    };

    expect(
      failureTag(reconstructDagSession(seam([wrapper(graphEntry), wrapper(wrongRun)]), def.runId)),
    ).toBe("run-mismatch");
    expect(
      failureTag(
        reconstructDagSession(
          seam([
            wrapper({ ...graphEntry, event: { _tag: "final", outcome: "nonsense" as never } }),
          ]),
          def.runId,
        ),
      ),
    ).toBe("malformed");
    expect(
      failureTag(
        reconstructDagSession(
          seam([
            wrapper(graphEntry),
            wrapper({
              ...start,
              event: {
                _tag: "transition",
                transition: { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
                attempt: {
                  nodeId: "a",
                  attemptId: "bad",
                  ordinal: 1,
                  status: DagNodeStatus.Running,
                },
              },
            }),
          ]),
          def.runId,
        ),
      ),
    ).toBe("attempt-inconsistent");
    expect(
      failureTag(
        reconstructDagSession(
          seam([wrapper(graphEntry), wrapper({ ...graphEntry, seq: 1 })]),
          def.runId,
        ),
      ),
    ).toBe("ordering");
    expect(
      failureTag(
        reconstructDagSession(seam([wrapper(graphEntry), wrapper(start)]), def.runId, {
          limits: { transitions: 1 },
        }),
      ),
    ).toBe("limit");
    expect(
      failureTag(
        reconstructDagSession(
          seam([
            wrapper(graphEntry),
            wrapper({
              ...graphEntry,
              seq: 1,
              event: { _tag: "final", outcome: DagRunOutcome.Succeeded },
            }),
          ]),
          def.runId,
        ),
      ),
    ).toBe("final-inconsistent");
  });

  it("projects settled dependencies and AtLeastOneSucceeded guards after restart", () => {
    const def = definition(
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
    const store = seam();
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
    expect(status(recovered.graph, recovered.state, "synthesize")).toBe(DagNodeStatus.Blocked);
    expect(recovered.state.nodes[2]).toEqual({
      nodeId: "synthesize",
      status: DagNodeStatus.Blocked,
      reason: DagBlockedReason.CompletionGuard,
      blockedBy: ["review-a", "review-b"],
    });
    expect(recovered.terminalOutcome).toBe(DagRunOutcome.Failed);
  });
});
