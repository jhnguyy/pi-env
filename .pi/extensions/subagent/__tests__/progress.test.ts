import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "latest assistant text" }],
  timestamp: Date.now(),
  model: "m",
  stopReason: "stop",
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
};

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    agentLoop: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "message_end", message: assistant };
        yield { type: "turn_end" };
      },
      async result() {
        return [];
      },
    }),
  };
});

const { runSubagent } = await import("../execute");

let sessionDir: string | undefined;
afterEach(() => {
  if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
  sessionDir = undefined;
});

describe("subagent live progress", () => {
  it("uses the execution transcript for turn_end updates and final fallback", async () => {
    sessionDir = mkdtempSync(join(tmpdir(), "pi-subagent-progress-"));
    const updates: string[] = [];
    const usageUpdates: number[] = [];
    const parent = SessionManager.create("/tmp", sessionDir);
    const result = await runSubagent(
      { name: "progress", task: "x", tools: ["notes"], model: "test/model" },
      {
        cwd: "/tmp",
        sessionManager: parent,
        modelRegistry: {
          find: () => ({ provider: "test", id: "model" }),
          getApiKeyForProvider: async () => "key",
        },
      } as any,
      new Map([["notes", {
        capabilities: [],
        tool: { name: "notes", label: "Notes", description: "", parameters: {}, execute: async () => ({ content: [], details: null }) },
      }]]),
      {
        onUpdate: (update) => updates.push(update.content[0]?.type === "text" ? update.content[0].text : ""),
        onUsage: (details) => usageUpdates.push(details.usage.input),
      },
    );

    expect(updates.at(-1)).toBe("latest assistant text");
    expect(usageUpdates).toEqual([1]);
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toBe("latest assistant text");
  });
});
