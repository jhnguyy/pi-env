import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import * as Usage from "../usage";

type Stats = Pick<SessionStats, "tokens" | "cost" | "assistantMessages">;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "answer" }],
    api: "openai-completions",
    provider: "test",
    model: "m",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    },
    ...overrides,
  };
}

function fixture(maxTurns = 2) {
  let stats: Stats = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    assistantMessages: 0,
  };
  const run = new Usage.SubagentRunAccumulator(
    {
      name: "scout",
      task: "x",
      toolNames: [],
      modelOverride: undefined,
      sessionId: "session-1",
      sessionName: "sub-scout",
      cwd: "/tmp/project",
      maxTurns,
    },
    (turns) => turns >= maxTurns,
    () => Usage.usageFromSessionStats(stats),
  );
  return {
    run,
    setStats: (snapshot: Stats) => {
      stats = snapshot;
    },
  };
}

const billedStats: Stats = {
  tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
  cost: 2,
  assistantMessages: 7,
};
const billedUsage = { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, cost: 2, turns: 7 };

describe("native subagent usage", () => {
  it("maps cumulative session totals without treating total tokens as input or cost", () => {
    expect(Usage.usageFromSessionStats(billedStats)).toEqual(billedUsage);
    expect(
      Usage.usageFromSessionStats({
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
        assistantMessages: 0,
      }),
    ).toEqual(Usage.zeroUsage());
  });

  it("reads financial snapshots independently of diagnostic assistant and tool events", () => {
    const { run, setStats } = fixture();
    const message = assistant();
    expect(run.acceptEvent({ type: "message_end", message })).toBe(message);
    const tool: AgentMessage = {
      role: "toolResult",
      toolCallId: "nested",
      toolName: "subagent",
      content: [],
      details: {},
      isError: false,
      timestamp: 2,
      usage: message.usage,
    };
    expect(run.acceptEvent({ type: "message_end", message: tool })).toBe(tool);
    expect(run.usage).toEqual(Usage.zeroUsage());

    setStats(billedStats);
    const progress = run.progressResult();
    expect(progress.details.usage).toEqual(billedUsage);
    expect(run.assistantTurnCount).toBe(1);
    expect(run.turnLimitExceeded).toBe(false);

    // Native compaction/other usage can change financial totals without a message_end.
    setStats({
      ...billedStats,
      cost: 3.25,
      tokens: { ...billedStats.tokens, input: 16, total: 115 },
    });
    expect(run.usage).toEqual({ ...billedUsage, input: 16, cost: 3.25 });
    expect(run.success().details.usage).toEqual(run.usage);
    expect(progress.details.usage).toEqual(billedUsage);
    expect(run.assistantTurnCount).toBe(1);
  });
});

describe("subagent run summary", () => {
  it("shows placeholders before any finalized assistant output", () => {
    const { run } = fixture();
    expect(run.acceptEvent({ type: "agent_start" })).toBeUndefined();
    run.acceptEvent({ type: "message_start", message: assistant() });
    expect(run.output()).toBe("");
    expect(run.assistantTurnCount).toBe(0);
    expect(run.progressResult().content).toEqual([{ type: "text", text: "(running...)" }]);
    expect(run.success().content).toEqual([{ type: "text", text: "(no output)" }]);
  });

  it("keeps only the latest finalized assistant text and diagnostics", () => {
    const { run } = fixture();
    run.acceptEvent({
      type: "message_end",
      message: assistant({ stopReason: "error", errorMessage: "retry me" }),
    });
    const latest = assistant({
      model: "new-model",
      content: [
        { type: "text", text: "latest first" },
        { type: "thinking", thinking: "not output" },
        { type: "text", text: "latest second" },
      ],
    });
    run.acceptEvent({ type: "message_end", message: latest });
    run.acceptEvent({
      type: "message_end",
      message: { role: "user", content: "follow-up", timestamp: 3 },
    });
    run.acceptEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
    expect(run.output()).toBe("latest first\nlatest second");
    expect(run.success().details).toMatchObject({
      finalOutput: "latest first\nlatest second",
      model: "new-model",
      stopReason: "stop",
      errorMessage: undefined,
      isError: false,
      toolCallCount: 1,
      turnLimitExceeded: false,
    });
    // The summary owns text, not mutable assistant content.
    latest.content.length = 0;
    expect(run.output()).toBe("latest first\nlatest second");
  });

  it.each(["stop", "toolUse"] as const)(
    "uses run-local finalized turns for the limit: %s",
    (stopReason) => {
      const { run, setStats } = fixture();
      setStats(billedStats);
      run.acceptEvent({ type: "message_end", message: assistant({ stopReason: "toolUse" }) });
      expect(run.assistantTurnCount).toBe(1);
      expect(run.turnLimitExceeded).toBe(false);
      run.acceptEvent({ type: "message_end", message: assistant({ stopReason }) });
      expect(run.assistantTurnCount).toBe(2);
      const limited = stopReason === "toolUse";
      expect(run.turnLimitExceeded).toBe(limited);
      const output = limited
        ? "answer\n\n[Note: Turn limit (2) reached. Output may be incomplete.]"
        : "answer";
      expect(run.success().content).toEqual([{ type: "text", text: output }]);
      expect(run.success().details).toMatchObject({
        finalOutput: output,
        isError: false,
        turnLimitExceeded: limited,
        stopReason: limited ? "turn_limit" : "stop",
        usage: billedUsage,
      });
    },
  );

  it.each(["error", "aborted"] as const)(
    "retains incomplete finalized %s output and diagnostics",
    (stopReason) => {
      const { run, setStats } = fixture();
      setStats(billedStats);
      run.acceptEvent({
        type: "message_end",
        message: assistant({
          stopReason,
          errorMessage: stopReason === "error" ? "provider failed" : undefined,
          content: [{ type: "text", text: "partial answer" }],
        }),
      });
      expect(run.success().details).toMatchObject({
        finalOutput: "partial answer",
        isError: true,
        stopReason,
        errorMessage: stopReason === "error" ? "provider failed" : undefined,
        usage: billedUsage,
      });
    },
  );

  it("does not reuse an earlier answer when the latest assistant has no output", () => {
    const { run } = fixture(3);
    run.acceptEvent({ type: "message_end", message: assistant() });
    run.acceptEvent({
      type: "message_end",
      message: assistant({ stopReason: "aborted", content: [] }),
    });
    expect(run.output()).toBe("");
    expect(run.success().details).toMatchObject({ finalOutput: "(no output)", isError: true });
  });

  it.each([false, true])(
    "reports thrown failures without losing finalized output or native usage (aborted=%s)",
    (aborted) => {
      const { run, setStats } = fixture();
      run.acceptEvent({ type: "message_end", message: assistant() });
      setStats(billedStats);
      const result = run.failure(new Error("connection lost"), aborted);
      expect(result.content).toEqual([
        { type: "text", text: aborted ? "Subagent aborted." : "Subagent error: connection lost" },
      ]);
      expect(result.details).toMatchObject({
        finalOutput: "answer",
        isError: true,
        stopReason: aborted ? "aborted" : "error",
        errorMessage: aborted ? undefined : "connection lost",
        usage: billedUsage,
      });
    },
  );
});
