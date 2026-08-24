import { describe, expect, it } from "vitest";
import {
  DagAttemptOrdinal,
  DagNodeResultTag,
  DagNodeStatus,
  dagAttemptId,
  dagAttemptStatus,
  dagResultStatus,
  isDagAttemptStatus,
} from "../index.js";

describe("DAG attempt contract", () => {
  it("creates one deterministic attempt identity", () => {
    expect(dagAttemptId("run", "node")).toBe("run:node:1");
    expect(dagAttemptStatus("run", "node", DagNodeStatus.Running)).toEqual({
      nodeId: "node",
      attemptId: "run:node:1",
      ordinal: DagAttemptOrdinal,
      status: DagNodeStatus.Running,
    });
  });

  it.each([
    [DagNodeResultTag.Succeeded, DagNodeStatus.Succeeded],
    [DagNodeResultTag.Failed, DagNodeStatus.Failed],
    [DagNodeResultTag.Cancelled, DagNodeStatus.Cancelled],
    [DagNodeResultTag.Interrupted, DagNodeStatus.Interrupted],
  ] as const)("maps the %s result to its attempt status", (tag, status) => {
    const result =
      tag === DagNodeResultTag.Succeeded
        ? { _tag: tag, outputs: {} }
        : tag === DagNodeResultTag.Failed
          ? { _tag: tag, failure: "failure" }
          : { _tag: tag };
    expect(dagResultStatus(result)).toBe(status);
    expect(isDagAttemptStatus(status)).toBe(true);
  });
});
