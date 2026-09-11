import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runResolvedSubagentEffect, type RunSubagentOptions } from "../execute";

const captured = {
  prompts: undefined as any,
  context: undefined as any,
  config: undefined as any,
  multiTurn: false,
  stopAfterFirst: undefined as boolean | undefined,
};
const agentLoop: NonNullable<RunSubagentOptions["agentLoop"]> = (prompts, context, config) => {
  captured.prompts = prompts;
  captured.context = context;
  captured.config = config;
  return {
    async *[Symbol.asyncIterator]() {
      if (!captured.multiTurn) return;
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "working" }],
          timestamp: Date.now(),
          model: "m",
          stopReason: "toolUse",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      };
      captured.stopAfterFirst = await config.shouldStopAfterTurn?.({} as any);
      if (captured.stopAfterFirst) return;
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          timestamp: Date.now(),
          model: "m",
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        },
      };
    },
    async result() {
      return [];
    },
  } as any;
};
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  captured.prompts = undefined;
  captured.context = undefined;
  captured.config = undefined;
  captured.multiTurn = false;
  captured.stopAfterFirst = undefined;
});

describe("resolved subagent boundary", () => {
  it("starts with empty messages and supplied tools without project-agent resolution", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-resolved-"));
    temps.push(cwd);
    const sessionManager = SessionManager.create(cwd, cwd);
    const tool = {
      name: "review_read",
      description: "d",
      parameters: {} as any,
      execute: async () => ({ content: [] }),
    };
    const ctx: any = {
      cwd,
      sessionManager,
      modelRegistry: { getApiKeyForProvider: () => undefined },
    };
    const result = await Effect.runPromise(
      runResolvedSubagentEffect(
        {
          name: "n",
          task: "task",
          tools: [tool as any],
          toolNames: ["review_read"],
          model: { provider: "p", id: "m" },
          systemPrompt: "sys",
          cwd,
        },
        ctx,
        { env: { OTEL_SDK_DISABLED: "true" }, agentLoop },
      ),
    );
    expect(captured.prompts).toMatchObject([{ role: "user" }]);
    expect(captured.context.messages).toEqual([]);
    expect(captured.context.tools).toEqual([tool]);
    expect(captured.config.sessionId).toBe(result.details.sessionId);
  });
});
