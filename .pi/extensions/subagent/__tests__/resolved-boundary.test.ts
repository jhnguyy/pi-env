import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runResolvedSubagentEffect } from "../execute";

const captured = vi.hoisted(() => ({ prompts: undefined as any, context: undefined as any }));
vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    agentLoop: (prompts: unknown, context: unknown) => {
      captured.prompts = prompts;
      captured.context = context;
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return [];
        },
      };
    },
  };
});
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  captured.prompts = undefined;
  captured.context = undefined;
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
    await Effect.runPromise(
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
        { env: { OTEL_SDK_DISABLED: "true" } },
      ),
    );
    expect(captured.prompts).toMatchObject([{ role: "user" }]);
    expect(captured.context.messages).toEqual([]);
    expect(captured.context.tools).toEqual([tool]);
  });
});
