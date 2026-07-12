import { describe, expect, it } from "vitest";

import { SubagentRunAccumulator, SubagentUsageLedger, zeroUsage } from "../usage";
import type { SubagentDetails } from "../types";

function details(name: string, input: number, output: number): SubagentDetails {
  return {
    name,
    task: "x",
    toolNames: [],
    modelOverride: undefined,
    finalOutput: "done",
    toolCallCount: 0,
    usage: { ...zeroUsage(), input, output, turns: 1 },
    isError: false,
    turnLimitExceeded: false,
  };
}

describe("subagent usage accumulation", () => {
  it("aggregates sync and async records exactly and idempotently", () => {
    const ledger = new SubagentUsageLedger();
    ledger.record("sync-1", "sync", details("scout", 2, 3));
    ledger.record("job-1", "async", details("builder", 5, 7));
    ledger.record("job-1", "async", details("builder", 50, 70));

    expect(ledger.rows()).toHaveLength(2);
    expect(ledger.total()).toMatchObject({ input: 7, output: 10, turns: 2 });
    expect(ledger.render()).toContain("total: 2t in:7 out:10");

    ledger.clear();
    expect(ledger.render()).toBe("No subagent usage recorded.");
  });

  it("accumulates transcript, usage, tool count, and turn-limit state", () => {
    const accumulator = new SubagentRunAccumulator({
      name: "scout",
      task: "x",
      toolNames: [],
      modelOverride: undefined,
      sessionId: "session-1",
      sessionName: "sub-scout",
      cwd: "/tmp/project",
    }, (turns) => turns >= 1);
    accumulator.acceptEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} });
    accumulator.acceptEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        api: "test",
        provider: "test",
        model: "m",
        stopReason: "stop",
        timestamp: 1,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
      } as any,
    });

    expect(accumulator.output()).toBe("answer");
    expect(accumulator.toolCallCount).toBe(1);
    expect(accumulator.usage).toMatchObject({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 });
    expect(accumulator.turnLimitExceeded).toBe(true);
  });
});
