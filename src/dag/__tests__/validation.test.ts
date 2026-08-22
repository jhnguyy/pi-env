import { describe, expect, it } from "vitest";
import {
  DagCompletionGuardKind,
  DagDependencyMode,
  DagValidationErrorTag,
  DagValidationResultTag,
  type DagDefinition,
  type DagValidationLimits,
  validateDagDefinition,
} from "../index.js";
import { definition, executor, node } from "./shared.js";

function tags(graph: DagDefinition, limits?: DagValidationLimits): string[] {
  const result = validateDagDefinition(graph, limits);
  expect(result._tag).toBe(DagValidationResultTag.Invalid);
  return result._tag === DagValidationResultTag.Invalid
    ? result.errors.map((error) => error._tag)
    : [];
}

describe("DAG validation", () => {
  it("rejects duplicate node IDs", () => {
    expect(validateDagDefinition(definition([node("build"), node("build")]))).toEqual({
      _tag: DagValidationResultTag.Invalid,
      errors: [
        {
          _tag: DagValidationErrorTag.DuplicateNode,
          nodeId: "build",
          firstIndex: 0,
          duplicateIndex: 1,
        },
      ],
    });
  });

  it("rejects missing and self dependencies", () => {
    expect(
      tags(
        definition([
          node("self", [{ nodeId: "self", mode: DagDependencyMode.Required }]),
          node("missing", [{ nodeId: "absent", mode: DagDependencyMode.Required }]),
        ]),
      ),
    ).toEqual([DagValidationErrorTag.SelfDependency, DagValidationErrorTag.MissingDependency]);
  });

  it("rejects every cyclic member but excludes acyclic descendants", () => {
    const result = validateDagDefinition(
      definition([
        node("descendant", [{ nodeId: "a", mode: DagDependencyMode.Required }]),
        node("a", [{ nodeId: "b", mode: DagDependencyMode.Required }]),
        node("b", [
          { nodeId: "a", mode: DagDependencyMode.Required },
          { nodeId: "c", mode: DagDependencyMode.Settled },
        ]),
        node("c", [{ nodeId: "b", mode: DagDependencyMode.Settled }]),
      ]),
    );

    expect(result).toEqual({
      _tag: DagValidationResultTag.Invalid,
      errors: [{ _tag: DagValidationErrorTag.Cycle, nodeIds: ["a", "b", "c"] }],
    });
  });

  it("enforces inclusive node and edge limits", () => {
    const limits: DagValidationLimits = {
      maxNodes: 3,
      maxEdges: 2,
      maxConcurrency: 3,
    };
    const atLimits = definition([
      node("a"),
      node("b"),
      node("c", [
        { nodeId: "a", mode: DagDependencyMode.Required },
        { nodeId: "b", mode: DagDependencyMode.Settled },
      ]),
    ]);
    expect(validateDagDefinition(atLimits, limits)._tag).toBe(DagValidationResultTag.Valid);
    expect(tags(definition([...atLimits.nodes, node("d")]), limits)).toEqual([
      DagValidationErrorTag.NodeLimitExceeded,
    ]);
    expect(
      tags(
        definition([
          node("a"),
          node("b"),
          node("c"),
          node("d", [
            { nodeId: "a", mode: DagDependencyMode.Required },
            { nodeId: "b", mode: DagDependencyMode.Required },
            { nodeId: "c", mode: DagDependencyMode.Required },
          ]),
        ]),
        { ...limits, maxNodes: 4 },
      ),
    ).toEqual([DagValidationErrorTag.EdgeLimitExceeded]);
  });

  it("rejects empty graphs and invalid concurrency", () => {
    expect(tags(definition([]))).toEqual([DagValidationErrorTag.EmptyGraph]);
    expect(tags(definition([node("task")], 0))).toEqual([
      DagValidationErrorTag.ConcurrencyLimitExceeded,
    ]);
  });

  it("rejects unsupported and duplicate dependency modes", () => {
    const unsupported = definition([
      node("source"),
      node("consumer", [{ nodeId: "source", mode: "optional" as never }]),
    ]);
    expect(tags(unsupported)).toEqual([DagValidationErrorTag.UnsupportedDependencyMode]);

    const duplicate = definition([
      node("source"),
      node("consumer", [
        { nodeId: "source", mode: DagDependencyMode.Required },
        { nodeId: "source", mode: DagDependencyMode.Settled },
      ]),
    ]);
    expect(tags(duplicate)).toContain(DagValidationErrorTag.DuplicateDependency);
  });

  it("accepts a success guard only over settled dependencies", () => {
    const guard = {
      kind: DagCompletionGuardKind.AtLeastOneSucceeded,
      dependencyIds: ["a", "b"],
    } as const;
    const valid = definition([
      node("a"),
      node("b"),
      node(
        "join",
        [
          { nodeId: "a", mode: DagDependencyMode.Settled },
          { nodeId: "b", mode: DagDependencyMode.Settled },
        ],
        guard,
      ),
    ]);
    expect(validateDagDefinition(valid)._tag).toBe(DagValidationResultTag.Valid);

    const invalid = definition([
      node("a"),
      node("join", [{ nodeId: "a", mode: DagDependencyMode.Required }], {
        ...guard,
        dependencyIds: ["a"],
      }),
    ]);
    expect(tags(invalid)).toContain(DagValidationErrorTag.InvalidCompletionGuard);
  });

  it("preserves opaque executor payload identity", () => {
    const payload = { arbitrary: ["opaque", 1, { nested: true }] };
    const result = validateDagDefinition({
      runId: "run-test",
      concurrency: 1,
      nodes: [
        {
          id: "task",
          executor: { ...executor, key: "opaque", payload },
          dependencies: [],
        },
      ],
    });

    expect(result._tag).toBe(DagValidationResultTag.Valid);
    if (result._tag === DagValidationResultTag.Valid) {
      expect(result.graph.nodes[0]?.executor.payload).toBe(payload);
    }
  });
});
