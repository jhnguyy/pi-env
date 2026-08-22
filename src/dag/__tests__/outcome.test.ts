import { describe, expect, it } from "vitest";
import {
  DagNodeResultTag,
  DagRunOutcome,
  DagRunOutcomeResultTag,
  createDagRunState,
  deriveDagRunOutcome,
} from "../index.js";
import * as Fixtures from "./shared.js";

const finish = (
  dag: ReturnType<typeof Fixtures.graph>,
  nodeId: string,
  result: ReturnType<typeof Fixtures.terminalResult>,
) => Fixtures.finish(dag, createDagRunState(dag), nodeId, result);

describe("DAG terminal outcomes", () => {
  it("uses fixed precedence independent of completion order", () => {
    const dag = Fixtures.graph([Fixtures.node("first"), Fixtures.node("second")]);
    const initial = createDagRunState(dag);
    expect(deriveDagRunOutcome(dag, initial)).toEqual({
      _tag: DagRunOutcomeResultTag.NonTerminal,
      nodeIds: ["first", "second"],
    });
    const failedThenCancelled = Fixtures.finish(
      dag,
      finish(dag, "first", Fixtures.terminalResult(DagNodeResultTag.Failed)),
      "second",
      Fixtures.terminalResult(DagNodeResultTag.Cancelled),
    );
    const cancelledThenFailed = Fixtures.finish(
      dag,
      finish(dag, "second", Fixtures.terminalResult(DagNodeResultTag.Cancelled)),
      "first",
      Fixtures.terminalResult(DagNodeResultTag.Failed),
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
    const dag = Fixtures.graph([Fixtures.node("task")]);
    const state = finish(dag, "task", Fixtures.terminalResult(tag));
    expect(deriveDagRunOutcome(dag, state)).toEqual({
      _tag: DagRunOutcomeResultTag.Terminal,
      outcome,
    });
  });
});
