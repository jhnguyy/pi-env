import { describe, expect, it, vi } from "vitest";
import { DagSessionEntryType, type DagSessionEntry } from "../../../../src/dag/index.js";
import { makeDagSessionStore, persistedDagRunIds } from "../dag-session-store";

const entry = {
  v: 1,
  runId: "run-1",
  graphId: "graph-1",
  seq: 0,
  event: {
    _tag: "graph",
    graph: { runId: "run-1", concurrency: 1, nodes: [] },
  },
} as const satisfies DagSessionEntry;

describe("DAG parent session store", () => {
  it("isolates DAG entry wrappers from the DAG session layer", () => {
    const appendCustomEntry = vi.fn(() => "entry-id");
    const store = makeDagSessionStore({
      getBranch: () => [
        { type: "custom", customType: "other", data: { runId: "other" } },
        { type: "custom", customType: DagSessionEntryType, data: entry },
      ],
      appendCustomEntry,
    });

    expect(store.read()).toEqual([entry]);
    store.append(entry);
    expect(appendCustomEntry).toHaveBeenCalledWith(DagSessionEntryType, entry);
  });

  it("derives claimed run IDs from session-native entries", () => {
    const store = makeDagSessionStore({
      getBranch: () => [
        { type: "custom", customType: DagSessionEntryType, data: entry },
        { type: "custom", customType: DagSessionEntryType, data: null },
      ],
      appendCustomEntry: () => "entry-id",
    });

    expect(persistedDagRunIds(store)).toEqual(new Set(["run-1"]));
  });
});
