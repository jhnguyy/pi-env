import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { runResolvedSubagentEffect, type RunSubagentOptions } from "../execute";

// Direct resolved callers (e.g. review) supply private tools without agent-file discovery.
// The public registered workflow covers prompt persistence; this adapter check retains
// the distinct supplied-tool and child session-affinity contract without running inference.
const captured = { context: undefined as any, config: undefined as any };
const agentLoop: NonNullable<RunSubagentOptions["agentLoop"]> = (_prompts, context, config) => {
  captured.context = context;
  captured.config = config;
  return {
    async *[Symbol.asyncIterator]() {},
    async result() { return []; },
  } as any;
};
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  captured.context = undefined;
  captured.config = undefined;
});

describe("resolved subagent boundary", () => {
  it("uses supplied private tools and child session affinity without project-agent resolution", async () => {
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
    expect(captured.context.tools).toEqual([tool]);
    expect(captured.config.sessionId).toBe(result.details.sessionId);
  });
});
