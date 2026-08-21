import { describe, expect, it } from "vitest";
import {
  DagCompletionGuardKind,
  DagDependencyMode,
  DagExecutorKind,
  DagValidationErrorTag,
  DagValidationResultTag,
  type DagDefinition,
  type DagValidationLimits,
  validateDagDefinition,
} from "../index.js";

const executor = {
  kind: DagExecutorKind.Transform,
  key: "test",
  payload: undefined,
} as const;

function definition(nodes: DagDefinition["nodes"], concurrency = 2): DagDefinition {
  return { runId: "run-test", concurrency, nodes };
}

function errorTags(graph: DagDefinition, limits?: DagValidationLimits): string[] {
  const result = validateDagDefinition(graph, limits);
  expect(result._tag).toBe(DagValidationResultTag.Invalid);
  return result._tag === DagValidationResultTag.Invalid
    ? result.errors.map((error) => error._tag)
    : [];
}

describe("DAG graph validation", () => {
  it("rejects duplicate node IDs before canonical indexing", () => {
    const result = validateDagDefinition(
      definition([
        { id: "build", executor, dependencies: [] },
        { id: "build", executor, dependencies: [] },
      ]),
    );

    expect(result).toEqual({
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

  it("rejects dependencies that do not name a graph node", () => {
    const result = validateDagDefinition(
      definition([
        {
          id: "test",
          executor,
          dependencies: [{ nodeId: "missing-build", mode: DagDependencyMode.Required }],
        },
      ]),
    );

    expect(result).toEqual({
      _tag: DagValidationResultTag.Invalid,
      errors: [
        {
          _tag: DagValidationErrorTag.MissingDependency,
          nodeId: "test",
          dependencyId: "missing-build",
        },
      ],
    });
  });

  it("rejects self-dependencies", () => {
    expect(
      errorTags(
        definition([
          {
            id: "lint",
            executor,
            dependencies: [{ nodeId: "lint", mode: DagDependencyMode.Required }],
          },
        ]),
      ),
    ).toContain(DagValidationErrorTag.SelfDependency);
  });

  it("rejects cycles and reports involved nodes in declaration order", () => {
    const graph = definition([
      {
        id: "cycle-descendant",
        executor,
        dependencies: [{ nodeId: "a", mode: DagDependencyMode.Required }],
      },
      {
        id: "a",
        executor,
        dependencies: [{ nodeId: "b", mode: DagDependencyMode.Required }],
      },
      {
        id: "b",
        executor,
        dependencies: [
          { nodeId: "a", mode: DagDependencyMode.Required },
          { nodeId: "c", mode: DagDependencyMode.Settled },
        ],
      },
      {
        id: "c",
        executor,
        dependencies: [{ nodeId: "b", mode: DagDependencyMode.Settled }],
      },
    ]);

    expect(validateDagDefinition(graph)).toEqual({
      _tag: DagValidationResultTag.Invalid,
      errors: [
        {
          _tag: DagValidationErrorTag.Cycle,
          nodeIds: ["a", "b", "c"],
        },
      ],
    });
  });

  it("enforces inclusive node and edge limits", () => {
    const limits: DagValidationLimits = {
      maxNodes: 3,
      maxEdges: 2,
      maxConcurrency: 3,
    };
    const atLimits = definition([
      { id: "a", executor, dependencies: [] },
      { id: "b", executor, dependencies: [] },
      {
        id: "c",
        executor,
        dependencies: [
          { nodeId: "a", mode: DagDependencyMode.Required },
          { nodeId: "b", mode: DagDependencyMode.Settled },
        ],
      },
    ]);
    expect(validateDagDefinition(atLimits, limits)._tag).toBe(DagValidationResultTag.Valid);

    const tooManyNodes = definition([...atLimits.nodes, { id: "d", executor, dependencies: [] }]);
    expect(errorTags(tooManyNodes, limits)).toEqual([DagValidationErrorTag.NodeLimitExceeded]);

    const tooManyEdges = definition([
      { id: "a", executor, dependencies: [] },
      { id: "b", executor, dependencies: [] },
      { id: "c", executor, dependencies: [] },
      {
        id: "d",
        executor,
        dependencies: [
          { nodeId: "a", mode: DagDependencyMode.Required },
          { nodeId: "b", mode: DagDependencyMode.Required },
          { nodeId: "c", mode: DagDependencyMode.Required },
        ],
      },
    ]);
    expect(errorTags(tooManyEdges, { ...limits, maxNodes: 4 })).toEqual([
      DagValidationErrorTag.EdgeLimitExceeded,
    ]);
  });

  it("rejects malformed runtime graph structure without throwing", () => {
    const malformed = { runId: "run-test", concurrency: 1, nodes: null };

    expect(validateDagDefinition(malformed as unknown as DagDefinition)).toEqual({
      _tag: DagValidationResultTag.Invalid,
      errors: [{ _tag: DagValidationErrorTag.InvalidDefinition }],
    });
  });

  it("rejects unsupported dependency modes at the runtime boundary", () => {
    const graph = definition([
      { id: "source", executor, dependencies: [] },
      {
        id: "consumer",
        executor,
        dependencies: [{ nodeId: "source", mode: "optional" }],
      },
    ] as unknown as DagDefinition["nodes"]);

    expect(validateDagDefinition(graph)).toEqual({
      _tag: DagValidationResultTag.Invalid,
      errors: [
        {
          _tag: DagValidationErrorTag.UnsupportedDependencyMode,
          nodeId: "consumer",
          dependencyId: "source",
          mode: "optional",
        },
      ],
    });
  });

  it("rejects duplicate dependency pairs instead of selecting a mode", () => {
    const graph = definition([
      { id: "source", executor, dependencies: [] },
      {
        id: "consumer",
        executor,
        dependencies: [
          { nodeId: "source", mode: DagDependencyMode.Required },
          { nodeId: "source", mode: DagDependencyMode.Settled },
        ],
      },
    ]);

    expect(errorTags(graph)).toContain(DagValidationErrorTag.DuplicateDependency);
  });

  it("accepts a fan-in guard only for a nonempty set of settled dependencies", () => {
    const valid = definition([
      { id: "review-a", executor, dependencies: [] },
      { id: "review-b", executor, dependencies: [] },
      {
        id: "synthesize",
        executor,
        dependencies: [
          { nodeId: "review-a", mode: DagDependencyMode.Settled },
          { nodeId: "review-b", mode: DagDependencyMode.Settled },
        ],
        completionGuard: {
          kind: DagCompletionGuardKind.AtLeastOneSucceeded,
          dependencyIds: ["review-a", "review-b"],
        },
      },
    ]);
    expect(validateDagDefinition(valid)._tag).toBe(DagValidationResultTag.Valid);

    const requiredMember = definition([
      { id: "review", executor, dependencies: [] },
      {
        id: "synthesize",
        executor,
        dependencies: [{ nodeId: "review", mode: DagDependencyMode.Required }],
        completionGuard: {
          kind: DagCompletionGuardKind.AtLeastOneSucceeded,
          dependencyIds: ["review"],
        },
      },
    ]);
    expect(errorTags(requiredMember)).toContain(DagValidationErrorTag.InvalidCompletionGuard);
  });

  it("preserves executor payloads without inspecting or cloning them", () => {
    const payload = { arbitrary: ["opaque", 1, { nested: true }] };
    const result = validateDagDefinition(
      definition([
        {
          id: "task",
          executor: { kind: DagExecutorKind.Transform, key: "opaque", payload },
          dependencies: [],
        },
      ]),
    );

    expect(result._tag).toBe(DagValidationResultTag.Valid);
    if (result._tag === DagValidationResultTag.Valid) {
      expect(result.graph.nodes[0]?.executor.payload).toBe(payload);
    }
  });
});
