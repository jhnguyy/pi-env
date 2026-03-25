/**
 * Tests for the subagent extension.
 *
 * Focus: synchronous / unit-testable paths — error returns, render functions,
 * parameter validation. We do NOT invoke agentLoop (requires real API keys).
 */

import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { Container, Text } from "@mariozechner/pi-tui";
import initSubagent from "../index";

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
    registeredTool = tool;
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

/** Extract text string from a Text or Container component. */
function extractText(component: Text | Container): string {
  if (component instanceof Container) {
    return component.children
      .map((c: any) => extractText(c as Text | Container))
      .join("\n");
  }
  return (component as any).text ?? "";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describeIfEnabled("subagent", "subagent extension", () => {
  // ─── Tool registration ───────────────────────────────────────────────────

  describe("tool registration", () => {
    it("registers a tool named 'subagent'", () => {
      expect(registeredTool).toBeDefined();
      expect(registeredTool.name).toBe("subagent");
    });

    it("has execute, renderCall, and renderResult methods", () => {
      expect(typeof registeredTool.execute).toBe("function");
      expect(typeof registeredTool.renderCall).toBe("function");
      expect(typeof registeredTool.renderResult).toBe("function");
    });

    it("has a description string", () => {
      expect(typeof registeredTool.description).toBe("string");
      expect(registeredTool.description.length).toBeGreaterThan(0);
    });
  });

  // ─── Extension tool registration ─────────────────────────────────────────

  describe("extension tool registration", () => {
    it("listens on 'agent-tools:register' channel", () => {
      expect(eventListeners.has("agent-tools:register")).toBe(true);
    });

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
        { task: "do something", tools: ["notes"], model: "anthropic/nonexistent" },
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
        { task: "do something", tools: ["fakeTool"] },
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
        { task: "do something" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No tools or capabilities specified");
      expect(result.details.stopReason).toBe("no_tools");
      expect(result.details.isError).toBe(true);
    });

    it("returns error when tools is empty array", async () => {
      const result = await registeredTool.execute(
        "call-v2",
        { task: "do something", tools: [] },
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
        { task: "do something", tools: ["read"] },
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
        { task: "do something", tools: ["read", "nonexistent"], model: "anthropic/claude-haiku-4-5" },
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
        { task: "do something", tools: ["fakeTool"], model: "anthropic/claude-haiku-4-5" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Available:");
    });

    it("error details have correct shape for unknown tools", async () => {
      const result = await registeredTool.execute(
        "call-3",
        { task: "test task", tools: ["unknown"], model: "anthropic/claude-haiku-4-5" },
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
        { task: "do something", tools: ["read"], model: "anthropic/nonexistent-model" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Model not found");
      expect(result.content[0].text).toContain("anthropic/nonexistent-model");
    });

    it("error details for missing model have correct shape", async () => {
      const result = await registeredTool.execute(
        "call-7",
        { task: "task", tools: ["read"], model: "anthropic/ghost-model" },
        undefined,
        undefined,
        mockCtx,
      );
      const details = result.details;
      expect(details.isError).toBe(true);
      expect(details.stopReason).toBe("model_not_found");
    });

    it("returns error when no model specified (no agent, no model param)", async () => {
      const result = await registeredTool.execute(
        "call-8",
        { task: "do something", tools: ["read"] },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No model specified");
    });

    it("error details for no model have correct shape", async () => {
      const result = await registeredTool.execute(
        "call-9",
        { task: "task", tools: ["read"] },
        undefined,
        undefined,
        mockCtx,
      );
      const details = result.details;
      expect(details.isError).toBe(true);
      expect(details.stopReason).toBe("no_model");
    });

    it("bare model name (no slash) uses getAvailable() for lookup", () => {
      // Verify that our mock registry supports getAvailable() — the lookup mechanism
      // for bare model names. The execute() path that reaches agentLoop can't be
      // tested without real API keys, but we can verify the lookup table is correct.
      const available = mockCtx.modelRegistry.getAvailable();
      const found = available.find(
        (m: any) => m.id === "claude-haiku-4-5" || m.id.includes("claude-haiku-4-5"),
      );
      expect(found).toBeDefined();
      expect(found?.id).toBe("claude-haiku-4-5");
    });

    it("bare model name not found returns model_not_found", async () => {
      const result = await registeredTool.execute(
        "call-11",
        { task: "task", tools: ["read"], model: "completely-unknown-model" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.details.stopReason).toBe("model_not_found");
    });

    it("provider/id format not found returns model_not_found", async () => {
      const result = await registeredTool.execute(
        "call-12",
        { task: "task", tools: ["read"], model: "anthropic/does-not-exist" },
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
        { task: "do something", agent: "nonexistent-agent" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Agent not found");
      expect(result.content[0].text).toContain("nonexistent-agent");
      expect(result.content[0].text).toContain("Available:");
      expect(result.details.stopReason).toBe("agent_not_found");
    });

    it("agent_not_found error details have correct shape", async () => {
      const result = await registeredTool.execute(
        "call-a2",
        { task: "agent task", agent: "no-such-agent" },
        undefined,
        undefined,
        mockCtx,
      );
      const details = result.details;
      expect(details.isError).toBe(true);
      expect(details.stopReason).toBe("agent_not_found");
      expect(details.task).toBe("agent task");
    });
  });

  // ─── execute: buildErrorDetails shape ────────────────────────────────────

  describe("execute — error detail builder", () => {
    it("details always include usage stats object", async () => {
      const result = await registeredTool.execute(
        "call-11b",
        { task: "my task", tools: ["bogus"], model: "anthropic/claude-haiku-4-5" },
        undefined,
        undefined,
        mockCtx,
      );
      const { usage } = result.details;
      expect(typeof usage.input).toBe("number");
      expect(typeof usage.output).toBe("number");
      expect(typeof usage.cacheRead).toBe("number");
      expect(typeof usage.cacheWrite).toBe("number");
      expect(typeof usage.cost).toBe("number");
      expect(typeof usage.turns).toBe("number");
    });

    it("details always include toolNames array", async () => {
      const result = await registeredTool.execute(
        "call-12b",
        { task: "task", tools: ["bad"], model: "anthropic/claude-haiku-4-5" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(Array.isArray(result.details.toolNames)).toBe(true);
    });

    it("details include the original task string", async () => {
      const result = await registeredTool.execute(
        "call-13",
        { task: "original task text", tools: ["bad"], model: "anthropic/claude-haiku-4-5" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.details.task).toBe("original task text");
    });
  });

  // ─── renderCall ──────────────────────────────────────────────────────────

  describe("renderCall", () => {
    it("returns a Text instance", () => {
      const result = registeredTool.renderCall(
        { task: "Summarize the auth flow", tools: ["read"], model: "anthropic/claude-haiku-4-5" },
        mockTheme,
      );
      expect(result instanceof Text).toBe(true);
    });

    it("contains the task preview", () => {
      const result = registeredTool.renderCall(
        { task: "Read src/auth and summarize", tools: ["read"], model: "anthropic/claude-haiku-4-5" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("Read src/auth and summarize");
    });

    it("truncates long tasks to 70 chars with ellipsis", () => {
      const longTask = "A".repeat(80);
      const result = registeredTool.renderCall(
        { task: longTask, tools: ["read"], model: "anthropic/claude-haiku-4-5" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("...");
      expect(t).not.toContain("A".repeat(75));
    });

    it("shows no tools section when none specified", () => {
      const result = registeredTool.renderCall(
        { task: "do something" },
        mockTheme,
      );
      const t = extractText(result);
      // No tools in brackets when not provided
      expect(t).not.toContain("[");
    });

    it("shows explicit tools when provided", () => {
      const result = registeredTool.renderCall(
        { task: "do something", tools: ["read", "write", "grep"] },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("read");
      expect(t).toContain("write");
      expect(t).toContain("grep");
    });

    it("shows model override when provided", () => {
      const result = registeredTool.renderCall(
        { task: "do something", tools: ["read"], model: "anthropic/claude-haiku-4-5" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("anthropic/claude-haiku-4-5");
    });

    it("does not show model info when not provided", () => {
      const result = registeredTool.renderCall(
        { task: "do something" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).not.toContain("(anthropic");
    });

    it("contains the tool name 'subagent'", () => {
      const result = registeredTool.renderCall(
        { task: "do something" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("subagent");
    });

    it("shows agent name when agent param provided", () => {
      const result = registeredTool.renderCall(
        { task: "do recon", agent: "scout" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("scout");
      expect(t).toContain("subagent");
    });

    it("does not show agent prefix when agent not specified", () => {
      const result = registeredTool.renderCall(
        { task: "do something", tools: ["read"] },
        mockTheme,
      );
      const t = extractText(result);
      // Should not contain any agent name prefix before the tools/task
      // (no "scout" or "gatherer" string appearing)
      expect(t).not.toContain("scout");
    });
  });

  // ─── renderResult — collapsed ────────────────────────────────────────────

  describe("renderResult — collapsed (default)", () => {
    const successDetails = {
      task: "Read the auth flow",
      toolNames: ["read", "bash"],
      modelOverride: undefined,
      finalOutput: "The auth flow is JWT-based.\nTokens expire in 1 hour.",
      toolCallCount: 3,
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.001, turns: 2 },
      model: "claude-sonnet-4-6",
      stopReason: "end_turn",
      isError: false,
      turnLimitExceeded: false,
    };

    it("returns a Text instance for success", () => {
      const result = registeredTool.renderResult(
        { content: [{ type: "text", text: "done" }], details: successDetails },
        {},
        mockTheme,
      );
      expect(result instanceof Text).toBe(true);
    });

    it("shows task preview", () => {
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: successDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("Read the auth flow");
    });

    it("shows output preview (first 3 lines)", () => {
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: successDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("The auth flow is JWT-based");
    });

    it("shows success icon (✓) for success", () => {
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: successDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("✓");
    });

    it("shows error icon (✗) for error", () => {
      const errorDetails = { ...successDetails, isError: true, errorMessage: "API failure" };
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: errorDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("✗");
    });

    it("shows warning icon (⚠) for turn limit exceeded", () => {
      const limitDetails = { ...successDetails, turnLimitExceeded: true };
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: limitDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("⚠");
    });

    it("shows error message for error state", () => {
      const errorDetails = {
        ...successDetails,
        isError: true,
        errorMessage: "Connection refused",
        stopReason: "error",
      };
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: errorDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("Connection refused");
    });

    it("shows '[turn limit]' for turn limit exceeded", () => {
      const limitDetails = { ...successDetails, turnLimitExceeded: true };
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: limitDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("[turn limit]");
    });

    it("shows tool call count in stats", () => {
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: successDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("3 tool calls");
    });

    it("shows Ctrl+O hint in collapsed view", () => {
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: successDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("Ctrl+O");
    });

    it("falls back gracefully when details are absent", () => {
      const result = registeredTool.renderResult(
        { content: [{ type: "text", text: "raw output" }] },
        {},
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("raw output");
    });

    it("shows agent name in collapsed view when present", () => {
      const agentDetails = { ...successDetails, agent: "scout" };
      const t = extractText(
        registeredTool.renderResult(
          { content: [], details: agentDetails },
          {},
          mockTheme,
        ),
      );
      expect(t).toContain("scout");
    });
  });

  // ─── renderResult — expanded ─────────────────────────────────────────────

  describe("renderResult — expanded", () => {
    const successDetails = {
      task: "Analyze the database schema",
      toolNames: ["read"],
      modelOverride: "anthropic/claude-haiku-4-5",
      finalOutput: "The schema has 5 tables.\nUsers table has 10 columns.",
      toolCallCount: 2,
      usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.0005, turns: 1 },
      model: "claude-haiku-4-5",
      stopReason: "end_turn",
      isError: false,
      turnLimitExceeded: false,
    };

    it("returns a Container for expanded success", () => {
      const result = registeredTool.renderResult(
        { content: [], details: successDetails },
        { expanded: true },
        mockTheme,
      );
      expect(result instanceof Container).toBe(true);
    });

    it("expanded view contains the task text", () => {
      const result = registeredTool.renderResult(
        { content: [], details: successDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("Analyze the database schema");
    });

    it("expanded view contains the model override", () => {
      const result = registeredTool.renderResult(
        { content: [], details: successDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("anthropic/claude-haiku-4-5");
    });

    it("expanded error view shows error message", () => {
      const errorDetails = {
        ...successDetails,
        isError: true,
        errorMessage: "Network timeout",
        stopReason: "error",
      };
      const result = registeredTool.renderResult(
        { content: [], details: errorDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("Network timeout");
    });

    it("expanded turn-limit view shows turn limit indicator", () => {
      const limitDetails = { ...successDetails, turnLimitExceeded: true };
      const result = registeredTool.renderResult(
        { content: [], details: limitDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("turn limit");
    });

    it("expanded view does NOT show Ctrl+O hint", () => {
      const result = registeredTool.renderResult(
        { content: [], details: successDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).not.toContain("Ctrl+O");
    });

    it("expanded view contains Task section header", () => {
      const result = registeredTool.renderResult(
        { content: [], details: successDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("Task");
    });

    it("expanded view contains Output section header", () => {
      const result = registeredTool.renderResult(
        { content: [], details: successDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("Output");
    });

    it("expanded view shows '(no output)' when finalOutput is empty", () => {
      const noOutputDetails = { ...successDetails, finalOutput: "" };
      const result = registeredTool.renderResult(
        { content: [], details: noOutputDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("(no output)");
    });

    it("expanded view shows agent name when present", () => {
      const agentDetails = { ...successDetails, agent: "gatherer" };
      const result = registeredTool.renderResult(
        { content: [], details: agentDetails },
        { expanded: true },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("gatherer");
    });
  });
});
