import { it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { describe, expect } from "vitest";
import {
  DagNodeResultTag,
  DagNodeStatus,
  DagRunOutcome,
  DagTransitionType,
  createDagSessionWriter,
  reconstructDagSession,
  validateDagDefinition,
  type DagDefinition,
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

function valid(def: DagDefinition) {
  const result = validateDagDefinition(def);
  expect(result._tag).toBe("valid");
  if (result._tag !== "valid") throw new Error("invalid graph");
  return result.graph;
}

function readOnlyStore(entries: readonly DagSessionEntry[]): DagSessionStore {
  return {
    read: () => [...entries],
    append: () => {
      throw new Error("Unexpected write to read-only session store");
    },
  };
}

function failureTag(effect: Effect.Effect<unknown, { readonly _tag: string }>) {
  const option = Exit.findErrorOption(Effect.runSyncExit(effect));
  expect(Option.isSome(option)).toBe(true);
  return Option.isSome(option) ? option.value._tag : "";
}

describe("DAG session writer", () => {
  it.effect("retries graph at sequence zero when the store rejects before recording", () =>
    Effect.gen(function* () {
      const def = Fixtures.definition([node("a")], 1);
      const dag = valid(def);
      const cause = new Error("store rejected before recording");
      let fail = true;
      const entries: DagSessionEntry[] = [];
      const store: DagSessionStore = {
        read: () => entries,
        append: (entry) => {
          if (fail) {
            fail = false;
            throw cause;
          }
          entries.push(entry);
        },
      };
      const writer = createDagSessionWriter(store, dag, def);
      const operation = writer.appendGraph(def);

      const error = yield* Effect.flip(operation);
      expect(error).toMatchObject({ _tag: "seam-failed", operation: "append" });
      expect(error._tag === "seam-failed" && error.cause).toBe(cause);
      expect(entries).toEqual([]);
      yield* operation;
      expect(entries.map((entry) => entry.seq)).toEqual([0]);
      const recovered = yield* reconstructDagSession(readOnlyStore(entries), def.runId);
      expect(recovered.persistedEntryCount).toBe(1);
    }),
  );

  it.effect.each(["Start", "Complete", "Final"] as const)(
    "retries %s without advancing writer history when the store rejects before recording",
    (failureStage) =>
      Effect.gen(function* () {
        const def = Fixtures.definition([node("a")], 1);
        const dag = valid(def);
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

        yield* writer.appendGraph(def);
        for (const [stage, operation] of [
          ["Start", start],
          ["Complete", complete],
          ["Final", final],
        ] as const) {
          if (stage === failureStage) {
            const prefix = structuredClone(entries);
            expect(prefix).toHaveLength({ Start: 1, Complete: 2, Final: 3 }[stage]);
            failNext = true;
            const error = yield* Effect.flip(operation);
            expect(error).toMatchObject({ _tag: "seam-failed", operation: "append" });
            expect(error._tag === "seam-failed" && error.cause).toBe(cause);
            expect(entries).toEqual(prefix);
          }
          yield* operation;
        }

        expect(entries.map((entry) => entry.seq)).toEqual([0, 1, 2, 3]);
        const history = structuredClone(entries);
        const recovered = yield* reconstructDagSession(readOnlyStore(history), def.runId);
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

        expect((yield* Effect.flip(final))._tag).toBe("ordering");
        expect((yield* Effect.flip(start))._tag).toBe("ordering");
        expect(entries).toEqual(history);
      }),
  );

  it("rejects a definition that does not match the validated graph", () => {
    const def = Fixtures.definition([node("a")], 1);
    const dag = valid(def);
    const mismatchedDefinition = Fixtures.definition([node("other")], 1);
    const mismatchWriter = createDagSessionWriter(
      Fixtures.sessionStore(),
      dag,
      mismatchedDefinition,
    );
    expect(failureTag(mismatchWriter.appendGraph(mismatchedDefinition))).toBe("graph-mismatch");
  });

  it("rejects a transition beyond the persisted entry limit", () => {
    const def = Fixtures.definition([node("a")], 1);
    const dag = valid(def);
    const boundedStore = Fixtures.sessionStore();
    const boundedWriter = createDagSessionWriter(boundedStore, dag, def, {
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
});
