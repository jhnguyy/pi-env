import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import {
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionType,
  computeDagSessionGraphId,
  createDagSessionWriter,
  reconstructDagSession,
  type DagSessionEntry,
  type DagSessionStore,
} from "../index.js";
import * as Fixtures from "./shared.js";

function node(id: string) {
  return {
    id,
    executor: { kind: "transform" as const, key: "test", payload: null },
    dependencies: [],
  };
}

describe("DAG session writer", () => {
  it.effect(
    "retries each rejected append without advancing history and reconstructs the committed lifecycle",
    () =>
      Effect.gen(function* () {
        const def = Fixtures.definition([node("a")], 1);
        const dag = Fixtures.graph(def.nodes, 1);
        const cause = new Error("store rejected before recording");
        let failNext = false;
        const entries: DagSessionEntry[] = [];
        const store: DagSessionStore = {
          read: () => entries,
          append: (entry) => {
            if (failNext) {
              failNext = false;
              throw cause;
            }
            entries.push(entry);
          },
        };
        const writer = createDagSessionWriter(store, dag, def);
        const start = writer.appendTransition(
          { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
          { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Running },
        );
        const complete = writer.appendTransition(
          {
            runId: def.runId,
            nodeId: "a",
            type: DagTransitionType.Complete,
            result: { _tag: DagNodeResultTag.Succeeded, outputs: { answer: 42 } },
          },
          {
            nodeId: "a",
            attemptId: `${def.runId}:a:1`,
            ordinal: 1,
            status: DagNodeStatus.Succeeded,
          },
        );
        const final = writer.appendFinal(DagRunOutcome.Succeeded);

        for (const operation of [writer.appendGraph(def), start, complete, final]) {
          const prefix = structuredClone(entries);
          failNext = true;
          const error = yield* Effect.flip(operation);
          expect(error).toMatchObject({ _tag: "seam-failed", operation: "append" });
          expect(error._tag === "seam-failed" && error.cause).toBe(cause);
          expect(entries).toEqual(prefix);
          yield* operation;
        }

        expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
        const history = structuredClone(entries);
        expect((yield* Effect.flip(final))._tag).toBe("ordering");
        expect((yield* Effect.flip(start))._tag).toBe("ordering");
        expect(entries).toEqual(history);

        const snapshot = [...history, { runId: "unrelated-run", malformed: true }];
        const reader: DagSessionStore = {
          read: () => structuredClone(snapshot),
          append: () => {
            throw new Error("Unexpected write to read-only session store");
          },
        };
        const recovered = yield* reconstructDagSession(reader, def.runId, {
          limits: { totalMatchingEntries: 4 },
        });
        expect(recovered.graphId).toBe(computeDagSessionGraphId(def));
        expect(recovered.persistedEntryCount).toBe(4);
        expect(recovered.state.nodes).toEqual([
          { nodeId: "a", status: DagNodeStatus.Succeeded, outputs: { answer: 42 } },
        ]);
        expect(recovered.attempts).toEqual([
          {
            nodeId: "a",
            attemptId: `${def.runId}:a:1`,
            ordinal: 1,
            statuses: [DagNodeStatus.Running, DagNodeStatus.Succeeded],
          },
        ]);
        expect(recovered.terminalOutcome).toBe(DagRunOutcome.Succeeded);
        expect(recovered.recoveredFromProcessLoss).toBe(false);
      }),
  );

  it.effect("rejects a definition that does not match the validated graph without writing", () =>
    Effect.gen(function* () {
      const dag = Fixtures.graph([node("a")], 1);
      const def = Fixtures.definition([node("other")], 1);
      const store = Fixtures.sessionStore();
      const writer = createDagSessionWriter(store, dag, def);
      expect((yield* Effect.flip(writer.appendGraph(def)))._tag).toBe("graph-mismatch");
      expect(store.entries).toEqual([]);
    }),
  );

  it.effect("rejects a transition beyond the persisted entry limit without changing history", () =>
    Effect.gen(function* () {
      const def = Fixtures.definition([node("a")], 1);
      const dag = Fixtures.graph(def.nodes, 1);
      const store = Fixtures.sessionStore();
      const writer = createDagSessionWriter(store, dag, def, {
        limits: { totalMatchingEntries: 1 },
      });
      yield* writer.appendGraph(def);
      const history = structuredClone(store.entries);
      const error = yield* Effect.flip(
        writer.appendTransition(
          { runId: def.runId, nodeId: "a", type: DagTransitionType.Start },
          { nodeId: "a", attemptId: `${def.runId}:a:1`, ordinal: 1, status: DagNodeStatus.Running },
        ),
      );
      expect(error._tag).toBe("limit");
      expect(store.entries).toEqual(history);
    }),
  );
});
