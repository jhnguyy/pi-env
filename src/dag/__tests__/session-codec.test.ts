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

describe("DAG session codec", () => {
  it("wraps getBranch seam failures without classifying them as malformed", () => {
    const def = Fixtures.definition([node("a")], 1);
    const store: DagSessionManagerSeam = {
      getBranch: () => {
        throw new Error("storage unavailable");
      },
      appendCustomEntry: () => "unreachable",
    };

    expect(failureTag(reconstructDagSession(store, def.runId))).toBe("seam-failed");
  });

  it("strictly rejects nested malformed inline graph shape before semantic validation", () => {
    const def = Fixtures.definition([node("a")], 1);
    const graphId = computeDagSessionGraphId(def);
    const graphEntry: DagSessionEntry = {
      v: 1,
      runId: def.runId,
      graphId,
      seq: 0,
      event: { _tag: "graph", graph: def },
    };

    expect(
      failureTag(
        reconstructDagSession(
          seam([
            wrapper({
              ...graphEntry,
              event: {
                _tag: "graph",
                graph: {
                  ...def,
                  nodes: [{ ...def.nodes[0], executor: { key: "missing-kind" } as never }],
                },
              },
            }),
          ]),
          def.runId,
        ),
      ),
    ).toBe("malformed");
    expect(
      failureTag(
        reconstructDagSession(
          seam([
            wrapper({
              ...graphEntry,
              event: {
                _tag: "graph",
                graph: {
                  ...def,
                  nodes: [{ ...def.nodes[0], dependencies: [{ nodeId: "a" }] as never }],
                },
              },
            }),
          ]),
          def.runId,
        ),
      ),
    ).toBe("malformed");
  });

  it("rejects malformed ordering, duplicate, truncated, reducer, version, and limit histories", () => {
    const def = Fixtures.definition([node("a")], 1);
    const graphId = computeDagSessionGraphId(def);
    const graphEntry: DagSessionEntry = {
      v: 1,
      runId: def.runId,
      graphId,
      seq: 0,
      event: { _tag: "graph", graph: def },
    };
    const malformedTransition = {
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
    } satisfies DagSessionEntry;

    const cases: readonly {
      readonly name: string;
      readonly entries: readonly unknown[];
      readonly expectedTag: string;
      readonly limits?: { readonly graphBytes?: number };
    }[] = [
      {
        name: "unsupported wire version",
        entries: [wrapper({ ...graphEntry, v: 2 as never })],
        expectedTag: "unsupported-version",
      },
      {
        name: "truncated first sequence",
        entries: [wrapper({ ...graphEntry, seq: 1 })],
        expectedTag: "truncated",
      },
      {
        name: "duplicate sequence",
        entries: [wrapper(graphEntry), wrapper({ ...graphEntry, seq: 0 })],
        expectedTag: "duplicate",
      },
      {
        name: "illegal reducer transition",
        entries: [wrapper(graphEntry), wrapper(malformedTransition)],
        expectedTag: "reducer-illegal",
      },
      {
        name: "graph byte limit",
        entries: [wrapper(graphEntry)],
        expectedTag: "limit",
        limits: { graphBytes: 8 },
      },
    ];

    for (const testCase of cases) {
      expect(
        failureTag(
          reconstructDagSession(seam([...testCase.entries]), def.runId, {
            limits: testCase.limits,
          }),
        ),
        testCase.name,
      ).toBe(testCase.expectedTag);
    }
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

  it("rejects wrong-run transitions, malformed wire payloads, repeated graphs, projection limits, and inconsistent finals with typed tags", () => {
    const def = Fixtures.definition([node("a")], 1);
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
});
