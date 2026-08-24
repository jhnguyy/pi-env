import { describe, expect, it } from "vitest";
import { DagExecutorKind } from "../contracts.js";

describe("validated DAG cross-bundle index", () => {
  it("shares the graph index through globalThis across isolated module instances", async () => {
    const moduleUrl = new URL("../internal/validated-graph.ts", import.meta.url).href;
    const producer = await import(/* @vite-ignore */ `${moduleUrl}?instance=producer`);
    const consumer = await import(/* @vite-ignore */ `${moduleUrl}?instance=consumer`);
    expect(producer).not.toBe(consumer);
    const built = producer.buildValidatedGraph(
      {
        runId: "cross-bundle",
        concurrency: 1,
        nodes: [
          {
            id: "node",
            executor: { kind: DagExecutorKind.Transform, key: "test", payload: null },
            dependencies: [],
          },
        ],
      },
      new Map([["node", 0]]),
    );
    expect(built._tag).toBe("valid");
    if (built._tag !== "valid") throw new Error("Expected a valid graph.");
    expect(consumer.getDagGraphIndex(built.graph).topologicalOrder).toEqual([0]);
  });
});
