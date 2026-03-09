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

const mockPi = {
  registerTool: (tool: any) => {
    registeredTool = tool;
  },
  on: () => {},
} as any;

// Initialize once — captures the tool registration
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
      return undefined;
    },
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

  // ─── execute: tool resolution ────────────────────────────────────────────

  describe("execute — tool resolution", () => {
    it("returns error for unknown tool names", async () => {
      const result = await registeredTool.execute(
        "call-1",
        { task: "do something", tools: ["read", "nonexistent"] },
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
        { task: "do something", tools: ["fakeTool"] },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Available:");
    });

    it("error details have correct shape for unknown tools", async () => {
      const result = await registeredTool.execute(
        "call-3",
        { task: "test task", tools: ["unknown"] },
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
    it("returns error when model format has no slash", async () => {
      const result = await registeredTool.execute(
        "call-4",
        { task: "do something", model: "invalidformat" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("Invalid model format");
      expect(result.content[0].text).toContain("invalidformat");
      expect(result.content[0].text).toContain("provider/model-id");
    });

    it("error details for bad model format have correct shape", async () => {
      const result = await registeredTool.execute(
        "call-5",
        { task: "task", model: "badformat" },
        undefined,
        undefined,
        mockCtx,
      );
      const details = result.details;
      expect(details.isError).toBe(true);
      expect(details.stopReason).toBe("invalid_model_format");
      expect(details.modelOverride).toBe("badformat");
    });

    it("returns error when model is not found in registry", async () => {
      const result = await registeredTool.execute(
        "call-6",
        { task: "do something", model: "anthropic/nonexistent-model" },
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
        { task: "task", model: "anthropic/ghost-model" },
        undefined,
        undefined,
        mockCtx,
      );
      const details = result.details;
      expect(details.isError).toBe(true);
      expect(details.stopReason).toBe("model_not_found");
    });

    it("returns error when no model is available at all", async () => {
      const noModelCtx = { ...mockCtx, model: undefined };
      const result = await registeredTool.execute(
        "call-8",
        { task: "do something" },
        undefined,
        undefined,
        noModelCtx,
      );
      expect(result.content[0].text).toContain("No model available");
    });

    it("error details for no model have correct shape", async () => {
      const noModelCtx = { ...mockCtx, model: undefined };
      const result = await registeredTool.execute(
        "call-9",
        { task: "task" },
        undefined,
        undefined,
        noModelCtx,
      );
      const details = result.details;
      expect(details.isError).toBe(true);
      expect(details.stopReason).toBe("no_model");
    });

    it("distinguishes bad format (no slash) from model-not-found", async () => {
      // "provider/unknown" parses correctly but isn't in registry → model_not_found
      const notFound = await registeredTool.execute(
        "call-10a",
        { task: "task", model: "anthropic/does-not-exist" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(notFound.details.stopReason).toBe("model_not_found");

      // "noslash" has no "/" → invalid_model_format (parsing fails before lookup)
      const badFormat = await registeredTool.execute(
        "call-10b",
        { task: "task", model: "noslash" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(badFormat.details.stopReason).toBe("invalid_model_format");
    });
  });

  // ─── execute: buildErrorDetails shape ────────────────────────────────────

  describe("execute — error detail builder", () => {
    it("details always include usage stats object", async () => {
      const result = await registeredTool.execute(
        "call-11",
        { task: "my task", tools: ["bogus"] },
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
        "call-12",
        { task: "task", tools: ["bad"] },
        undefined,
        undefined,
        mockCtx,
      );
      expect(Array.isArray(result.details.toolNames)).toBe(true);
    });

    it("details include the original task string", async () => {
      const result = await registeredTool.execute(
        "call-13",
        { task: "original task text", tools: ["bad"] },
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
        { task: "Summarize the auth flow" },
        mockTheme,
      );
      expect(result instanceof Text).toBe(true);
    });

    it("contains the task preview", () => {
      const result = registeredTool.renderCall(
        { task: "Read src/auth and summarize" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("Read src/auth and summarize");
    });

    it("truncates long tasks to 70 chars with ellipsis", () => {
      const longTask = "A".repeat(80);
      const result = registeredTool.renderCall({ task: longTask }, mockTheme);
      const t = extractText(result);
      expect(t).toContain("...");
      expect(t).not.toContain("A".repeat(75));
    });

    it("shows default tools when none specified", () => {
      const result = registeredTool.renderCall(
        { task: "do something" },
        mockTheme,
      );
      const t = extractText(result);
      expect(t).toContain("read");
      expect(t).toContain("bash");
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
        { task: "do something", model: "anthropic/claude-haiku-4-5" },
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
  });
});
