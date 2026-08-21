import { describe, expect, it } from "vitest";
import {
  DagNodeResultTag,
  DagRunOutcome,
  DagRunOutcomeResultTag,
  createDagRunState,
  deriveDagRunOutcome,
} from "../index.js";
import { finish as finishNode, graph, node, terminalResult } from "./shared.js";

const finish = (
  dag: ReturnType<typeof graph>,
  nodeId: string,
  result: ReturnType<typeof terminalResult>,
) => finishNode(dag, createDagRunState(dag), nodeId, result);

describe("DAG terminal outcomes", () => {
  it("uses fixed precedence independent of completion order", () => {
    const dag = graph([node("first"), node("second")]);
    const initial = createDagRunState(dag);
    expect(deriveDagRunOutcome(dag, initial)).toEqual({
      _tag: DagRunOutcomeResultTag.NonTerminal,
      nodeIds: ["first", "second"],
    });
    const failedThenCancelled = finishNode(
      dag,
      finish(dag, "first", terminalResult(DagNodeResultTag.Failed)),
      "second",
      terminalResult(DagNodeResultTag.Cancelled),
    );
    const cancelledThenFailed = finishNode(
      dag,
      finish(dag, "second", terminalResult(DagNodeResultTag.Cancelled)),
      "first",
      terminalResult(DagNodeResultTag.Failed),
    );
    expect(deriveDagRunOutcome(dag, failedThenCancelled)).toEqual({
      _tag: DagRunOutcomeResultTag.Terminal,
      outcome: DagRunOutcome.Failed,
    });
    expect(deriveDagRunOutcome(dag, cancelledThenFailed)).toEqual(
      deriveDagRunOutcome(dag, failedThenCancelled),
    );
  });

  it.each([
    [DagNodeResultTag.Succeeded, DagRunOutcome.Succeeded],
    [DagNodeResultTag.Cancelled, DagRunOutcome.Cancelled],
    [DagNodeResultTag.Interrupted, DagRunOutcome.Interrupted],
    [DagNodeResultTag.Failed, DagRunOutcome.Failed],
  ] as const)("maps %s to run outcome %s", (tag, outcome) => {
    const dag = graph([node("task")]);
    const state = finish(dag, "task", terminalResult(tag));
    expect(deriveDagRunOutcome(dag, state)).toEqual({
      _tag: DagRunOutcomeResultTag.Terminal,
      outcome,
    });
  });
});
