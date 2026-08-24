import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { DagExecutorKind } from "../../../src/dag/index.js";
import {
  lookupRegisteredDagExecutor,
  registerDagExecutor,
  removeDagExecutorsForSessionGeneration,
  resetDagExecutorRegistrationsForTests,
  unregisterDagExecutor,
} from "../_shared/dag-executor-registration";

const executor = () => Effect.succeed({});

beforeEach(resetDagExecutorRegistrationsForTests);

describe("session-generation DAG executor registration", () => {
  it("makes a deterministic executor available to a late generation lookup", () => {
    registerDagExecutor({
      parentSessionId: "parent",
      sessionGeneration: "generation",
      kind: DagExecutorKind.Materialize,
      key: "domain/materialize-v1",
      executor,
    });
    expect(
      lookupRegisteredDagExecutor(
        "parent",
        "generation",
        DagExecutorKind.Materialize,
        "domain/materialize-v1",
      ),
    ).toBe(executor);
  });

  it("rejects duplicate keys without replacing the active executor", () => {
    const active = registerDagExecutor({
      parentSessionId: "parent",
      sessionGeneration: "generation",
      kind: DagExecutorKind.Materialize,
      key: "domain/materialize-v1",
      executor,
    });
    expect(() =>
      registerDagExecutor({
        parentSessionId: "parent",
        sessionGeneration: "generation",
        kind: DagExecutorKind.Materialize,
        key: "domain/materialize-v1",
        executor: () => Effect.succeed({ other: true }),
      }),
    ).toThrow(/already registered/u);
    expect(
      lookupRegisteredDagExecutor(
        "parent",
        "generation",
        DagExecutorKind.Materialize,
        "domain/materialize-v1",
      ),
    ).toBe(executor);
    unregisterDagExecutor(active);
  });

  it("removes only the disposed generation and ignores stale unregister", () => {
    const stale = registerDagExecutor({
      parentSessionId: "parent",
      sessionGeneration: "old",
      kind: DagExecutorKind.Materialize,
      key: "domain/materialize-v1",
      executor,
    });
    const replacementExecutor = () => Effect.succeed({ replacement: true });
    registerDagExecutor({
      parentSessionId: "parent",
      sessionGeneration: "new",
      kind: DagExecutorKind.Materialize,
      key: "domain/materialize-v1",
      executor: replacementExecutor,
    });
    removeDagExecutorsForSessionGeneration("parent", "old");
    unregisterDagExecutor(stale);
    expect(
      lookupRegisteredDagExecutor(
        "parent",
        "old",
        DagExecutorKind.Materialize,
        "domain/materialize-v1",
      ),
    ).toBeUndefined();
    expect(
      lookupRegisteredDagExecutor(
        "parent",
        "new",
        DagExecutorKind.Materialize,
        "domain/materialize-v1",
      ),
    ).toBe(replacementExecutor);
  });
});
