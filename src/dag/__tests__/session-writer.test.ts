import { Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  DagBlockedReason,
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
  type DagCompletionGuardKind,
  type DagDefinition,
  type DagSessionEntry,
  type DagSessionManagerSeam,
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

describe("DAG session writer", () => {
  it("does not advance writer sequence or state when append fails", () => {
    const def = Fixtures.definition([node("a")], 1);
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

    expect(failureTag(writer.appendGraph(def))).toBe("seam-failed");
    Effect.runSync(writer.appendGraph(def));
    expect(Effect.runSync(reconstructDagSession(store, def.runId)).persistedEntryCount).toBe(1);

    const mismatchedDefinition = Fixtures.definition([node("other")], 1);
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
});
