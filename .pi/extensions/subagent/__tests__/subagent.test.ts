/**
 * Tests for the subagent extension.
 *
 * Focus: synchronous / unit-testable paths — error returns, render functions,
 * parameter validation. We do NOT invoke agentLoop (requires real API keys).
 */

import "../../__tests__/tui-setup";
import { describe, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { Container, type Text } from "@earendil-works/pi-tui";
import initSubagent, { completedJobUsageOnce } from "../index";

// ─── Mock theme ───────────────────────────────────────────────────────────────

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

// ─── Mock ExtensionAPI ────────────────────────────────────────────────────────

let registeredTool: any;

// Event listener map for testing agent-tools:register protocol
const eventListeners = new Map<string, Function[]>();

const mockPi = {
  registerTool: (tool: any) => {
    if (tool.name === "subagent") registeredTool = tool;
  },
  on: () => {},
  events: {
    on: (channel: string, handler: Function) => {
      if (!eventListeners.has(channel)) eventListeners.set(channel, []);
      eventListeners.get(channel)!.push(handler);
    },
    emit: (channel: string, data: any) => {
      for (const handler of eventListeners.get(channel) ?? []) handler(data);
    },
  },
} as any;

// Initialize once — captures the tool registration and event listeners
initSubagent(mockPi);

// ─── Mock ctx for execute ─────────────────────────────────────────────────────

const mockCtx = {
  cwd: "/tmp/test",
  model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic" },
  modelRegistry: {
    find: (provider: string, id: string) => {
      if (provider === "anthropic" && id === "claude-haiku-4-5") {
        return { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic" };
      }
      if (provider === "anthropic" && id === "claude-sonnet-4-6") {
        return { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic" };
      }
      return undefined;
    },
    getAvailable: () => [
      { provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic" },
      { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic" },
    ],
    getApiKeyForProvider: async () => "test-key",
  },
} as any;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runParams(params: Record<string, unknown>) {
  return { action: "run", name: "test-run", ...params };
}

/** Extract text string from a Text or Container component. */
function extractText(component: Text | Container): string {
  if (component instanceof Container) {
    return component.children.map((c: any) => extractText(c as Text | Container)).join("\n");
  }
  return (component as any).text ?? "";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describeIfEnabled("subagent", "subagent extension", () => {
  // ─── Tool registration ───────────────────────────────────────────────────

  describe("tool registration", () => {
    it("reports completed asynchronous usage exactly once", () => {
      const reported = new Set<string>();
      const job = {
        id: "job-1",
        status: "completed",
        latestDetails: {
          usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, cost: 1, turns: 1 },
        },
      } as any;
      expect(completedJobUsageOnce(reported, job)).toMatchObject({
        usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 },
      });
      expect(completedJobUsageOnce(reported, job)).toEqual({});
    });

    it("supports compact usage reporting for the active session", async () => {
      const result = await registeredTool.execute(
        "usage-1",
        { action: "usage" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toBe("No subagent usage recorded.");
      expect(result.details.status).toBe("usage");
    });
  });

  // ─── Extension tool registration ─────────────────────────────────────────

  describe("extension tool registration", () => {
    it("registered extension tool resolves and is available for subagents", async () => {
      // Emit a mock extension tool
      const mockExtTool = {
        name: "notes",
        label: "Notes",
        description: "Access vault notes",
        parameters: {},
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
      };
      mockPi.events.emit("agent-tools:register", {
        tool: mockExtTool,
        capabilities: ["read", "write"],
      });

      // Verify: using it in tools param succeeds tool resolution (fails at model, not tools)
      const result = await registeredTool.execute(
        "call-ext-1",
        runParams({ task: "do something", tools: ["notes"], model: "anthropic/nonexistent" }),
        undefined,
        undefined,
        mockCtx,
      );
      // Should fail at model_not_found, not invalid_tools — meaning "notes" resolved
      expect(result.details.stopReason).toBe("model_not_found");
      expect(result.content[0].text).not.toContain("Unknown tools");
    });

    it("includes registered extension tool names in unknown-tool error", async () => {
      // notes was already registered above
      const result = await registeredTool.execute(
        "call-ext-2",
        runParams({ task: "do something", tools: ["fakeTool"] }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Available:");
      expect(result.content[0].text).toContain("notes");
    });
  });

  // ─── execute: no-tools / no-model validation ─────────────────────────────

  describe("execute — required param validation", () => {
    it("returns error when no tools specified and no agent file", async () => {
      const result = await registeredTool.execute(
        "call-v1",
        runParams({ task: "do something" }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No tools or capabilities specified");
      expect(result.details.stopReason).toBe("no_tools");
      expect(result.details.isError).toBe(true);
      expect(result.usage).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
    });

    it("returns error when tools is empty array", async () => {
      const result = await registeredTool.execute(
        "call-v2",
        runParams({ task: "do something", tools: [] }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No tools or capabilities specified");
      expect(result.details.stopReason).toBe("no_tools");
    });

    it("returns error when tools provided but no model", async () => {
      const result = await registeredTool.execute(
        "call-v3",
        runParams({ task: "do something", tools: ["read"] }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No model specified");
      expect(result.details.stopReason).toBe("no_model");
      expect(result.details.isError).toBe(true);
    });
  });

  // ─── execute: tool resolution ────────────────────────────────────────────

  describe("execute — tool resolution", () => {
    it("returns error for unknown tool names", async () => {
      const result = await registeredTool.execute(
        "call-1",
        runParams({
          task: "do something",
          tools: ["read", "nonexistent"],
          model: "anthropic/claude-haiku-4-5",
        }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Unknown tools");
      expect(result.content[0].text).toContain("nonexistent");
    });

    it("includes available tools in the error message", async () => {
      const result = await registeredTool.execute(
        "call-2",
        runParams({
          task: "do something",
          tools: ["fakeTool"],
          model: "anthropic/claude-haiku-4-5",
        }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Available:");
    });

    it("error details have correct shape for unknown tools", async () => {
      const result = await registeredTool.execute(
        "call-3",
        runParams({
          task: "test task",
          tools: ["unknown"],
          model: "anthropic/claude-haiku-4-5",
        }),
        undefined,
        undefined,
        mockCtx,
      );
      const details = result.details;
      expect(details.isError).toBe(true);
      expect(details.task).toBe("test task");
      expect(details.toolNames).toContain("unknown");
      expect(details.stopReason).toBe("invalid_tools");
      expect(details.turnLimitExceeded).toBe(false);
      expect(details.toolCallCount).toBe(0);
    });
  });

  // ─── execute: model parsing ──────────────────────────────────────────────

  describe("execute — model parsing", () => {
    it("returns error when model is not found in registry (provider/id format)", async () => {
      const result = await registeredTool.execute(
        "call-6",
        runParams({
          task: "do something",
          tools: ["read"],
          model: "anthropic/nonexistent-model",
        }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Model not found");
      expect(result.content[0].text).toContain("anthropic/nonexistent-model");
    });

    it("returns error when no model specified (no agent, no model param)", async () => {
      const result = await registeredTool.execute(
        "call-8",
        runParams({ task: "do something", tools: ["read"] }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No model specified");
    });

    it("bare model name not found returns model_not_found", async () => {
      const result = await registeredTool.execute(
        "call-11",
        runParams({ task: "task", tools: ["read"], model: "completely-unknown-model" }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.details.stopReason).toBe("model_not_found");
    });

    it("provider/id format not found returns model_not_found", async () => {
      const result = await registeredTool.execute(
        "call-12",
        runParams({ task: "task", tools: ["read"], model: "anthropic/does-not-exist" }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.details.stopReason).toBe("model_not_found");
    });
  });

  // ─── execute: agent file resolution ─────────────────────────────────────

  describe("execute — agent file resolution", () => {
    it("returns error when named agent is not found", async () => {
      // discoverAgents reads real filesystem — "nonexistent-agent" won't be found
      const result = await registeredTool.execute(
        "call-a1",
        runParams({ task: "do something", agent: "nonexistent-agent" }),
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Agent not found");
      expect(result.content[0].text).toContain("nonexistent-agent");
      expect(result.content[0].text).toContain("Available:");
      expect(result.details.stopReason).toBe("agent_not_found");
    });
  });

  // ─── async tool rendering ────────────────────────────────────────────────

  describe("async tool rendering", () => {
    it("keeps accepted background-start acknowledgements out of the tool summary", () => {
      const longTask = "A".repeat(500);
      const call = extractText(
        registeredTool.renderCall(
          { action: "start", name: "audit", task: longTask, system_prompt: "private context" },
          mockTheme,
        ),
      );
      expect(call).toContain("subagent start");
      expect(call).toContain("audit");
      expect(call).toContain("...");
      expect(call).not.toContain("A".repeat(100));
      expect(call).not.toContain("private context");

      const result = {
        content: [{ type: "text", text: "Started subagent job job-1 (audit)." }],
        details: { jobId: "job-1", status: "queued", name: "audit" },
      };
      const context = { args: { action: "start", task: longTask } };
      expect(extractText(registeredTool.renderResult(result, {}, mockTheme, context))).toBe("");
      expect(
        extractText(registeredTool.renderResult(result, { expanded: true }, mockTheme, context)),
      ).toBe("");
    });

    it("keeps background child output hidden until expansion", () => {
      const longTask = `inspect ${"B".repeat(500)}`;
      const fullOutput = `full child output\n${"C".repeat(500)}`;
      const result = {
        content: [{ type: "text", text: fullOutput }],
        details: {
          jobId: "job-1",
          status: "completed",
          name: "audit",
          task: longTask,
          toolCallCount: 6,
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 4 },
          model: "test/model",
          sessionName: "sub-audit",
          sessionFile: "/sessions/sub-audit.jsonl",
          resultTruncated: true,
        },
      };

      const context = { args: { action: "result", job_id: "job-1" } };
      const collapsed = extractText(registeredTool.renderResult(result, {}, mockTheme, context));
      expect(collapsed).toContain("completed");
      expect(collapsed).toContain("6 tool calls");
      expect(collapsed).toContain("4 turns");
      expect(collapsed).toContain("sub-audit");
      expect(collapsed).toContain("/sessions/sub-audit.jsonl");
      expect(collapsed).toContain("result truncated");
      expect(collapsed).not.toContain("B".repeat(100));
      expect(collapsed).not.toContain(fullOutput);

      const expanded = extractText(
        registeredTool.renderResult(result, { expanded: true }, mockTheme, context),
      );
      expect(expanded).toContain(longTask);
      expect(expanded).toContain(fullOutput);
    });
  });

  // ─── synchronous tool rendering ─────────────────────────────────────────

  describe("synchronous tool rendering", () => {
    const successDetails = {
      task: "Analyze the database schema",
      toolNames: ["read", "bash"],
      modelOverride: "anthropic/claude-haiku-4-5",
      finalOutput: "The schema has 5 tables.\nUsers has 10 columns.",
      toolCallCount: 3,
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 2 },
      model: "claude-sonnet-4-6",
      stopReason: "end_turn",
      isError: false,
      turnLimitExceeded: false,
      agent: "scout",
      sessionName: "sub-schema-audit",
      sessionFile: "/sessions/sub-schema-audit.jsonl",
    };

    it("renders selected execution context with a bounded task preview", () => {
      const longTask = "A".repeat(500);
      const rendered = extractText(
        registeredTool.renderCall(
          {
            task: longTask,
            tools: ["read", "grep"],
            model: "anthropic/claude-haiku-4-5",
            agent: "scout",
            system_prompt: "private context",
          },
          mockTheme,
        ),
      );

      expect(rendered).toContain("subagent");
      expect(rendered).toContain("scout");
      expect(rendered).toContain("read");
      expect(rendered).toContain("grep");
      expect(rendered).toContain("anthropic/claude-haiku-4-5");
      expect(rendered).toContain("...");
      expect(rendered).not.toContain("A".repeat(100));
      expect(rendered).not.toContain("private context");
    });

    it("keeps delegated content out of the collapsed result summary", () => {
      const rendered = extractText(
        registeredTool.renderResult({ content: [], details: successDetails }, {}, mockTheme),
      );

      expect(rendered).toContain("scout");
      expect(rendered).toContain("3 tool calls");
      expect(rendered).toContain("2 turns");
      expect(rendered).toContain("sub-schema-audit");
      expect(rendered).not.toContain(successDetails.task);
      expect(rendered).not.toContain(successDetails.finalOutput);
    });

    it.each([
      [
        "an execution error",
        { isError: true, errorMessage: "Connection refused", stopReason: "error" },
        "Connection refused",
      ],
      ["a turn limit", { turnLimitExceeded: true }, "turn limit"],
    ])("identifies %s in the result summary", (_name, detailOverrides, expected) => {
      const rendered = extractText(
        registeredTool.renderResult(
          { content: [], details: { ...successDetails, ...detailOverrides } },
          {},
          mockTheme,
        ),
      );

      expect(rendered).toContain(expected);
    });

    it("falls back to public text when structured details are absent", () => {
      const rendered = extractText(
        registeredTool.renderResult(
          { content: [{ type: "text", text: "raw output" }] },
          {},
          mockTheme,
        ),
      );

      expect(rendered).toContain("raw output");
    });

    it("shows the full delegated task and child output after expansion", () => {
      const rendered = extractText(
        registeredTool.renderResult(
          { content: [], details: successDetails },
          { expanded: true },
          mockTheme,
        ),
      );

      expect(rendered).toContain(successDetails.task);
      expect(rendered).toContain(successDetails.finalOutput);
      expect(rendered).toContain(successDetails.modelOverride);
      expect(rendered).toContain(successDetails.sessionName);
      expect(rendered).toContain(successDetails.sessionFile);
    });
  });
});
