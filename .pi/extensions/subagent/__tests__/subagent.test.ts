/**
 * Tests for the subagent extension.
 *
 * Focus: synchronous / unit-testable paths — error returns, render functions,
 * parameter validation. Native execution is covered by integrated provider tests.
 */

import "../../__tests__/tui-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { componentText as extractText, expansionHints } from "../../__tests__/rendering";
import { createSubagentHarness } from "./harness";

// ─── Mock theme ───────────────────────────────────────────────────────────────

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const hints = { ...expansionHints, args: {}, isError: false };

// ─── Mock ExtensionAPI ────────────────────────────────────────────────────────

let registeredTool: any;

beforeEach(() => {
  registeredTool = createSubagentHarness().tools.get("subagent");
});

// ─── Mock ctx for execute ─────────────────────────────────────────────────────

const mockCtx = { cwd: "/tmp/test" } as any;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("subagent extension", () => {
  // ─── Tool registration ───────────────────────────────────────────────────

  describe("tool registration", () => {
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
      const context = { ...hints, args: { action: "start", task: longTask } };
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

      const context = {
        ...hints,
        args: { action: "result", job_id: "job-1" },
      };
      const collapsed = extractText(registeredTool.renderResult(result, {}, mockTheme, context));
      expect(collapsed).toContain("completed");
      expect(collapsed).toContain("6 tool calls");
      expect(collapsed).toContain("4 turns");
      expect(collapsed).toContain("sub-audit");
      expect(collapsed).toContain("/sessions/sub-audit.jsonl");
      expect(collapsed).toContain("result truncated");
      expect(collapsed).not.toContain("B".repeat(100));
      for (const line of fullOutput.split("\n")) expect(collapsed).not.toContain(line);

      const expanded = extractText(
        registeredTool.renderResult(result, { expanded: true }, mockTheme, context),
      );
      expect(expanded).toContain(longTask);
      for (const line of fullOutput.split("\n")) expect(expanded).toContain(line);
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
            system_prompt: "private context",
          },
          mockTheme,
        ),
      );

      expect(rendered).toContain("subagent");
      expect(rendered).toContain("read");
      expect(rendered).toContain("grep");
      expect(rendered).toContain("anthropic/claude-haiku-4-5");
      expect(rendered).toContain("...");
      expect(rendered).not.toContain("A".repeat(100));
      expect(rendered).not.toContain("private context");
    });

    it("keeps delegated content out of the collapsed result summary", () => {
      const rendered = extractText(
        registeredTool.renderResult({ content: [], details: successDetails }, {}, mockTheme, hints),
      );

      expect(rendered).toContain("3 tool calls");
      expect(rendered).toContain("2 turns");
      expect(rendered).toContain("sub-schema-audit");
      expect(rendered).not.toContain(successDetails.task);
      for (const line of successDetails.finalOutput.split("\n")) {
        expect(rendered).not.toContain(line);
      }
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
          hints,
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
          hints,
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
          hints,
        ),
      );

      expect(rendered).toContain(successDetails.task);
      for (const line of successDetails.finalOutput.split("\n")) expect(rendered).toContain(line);
      expect(rendered).toContain(successDetails.modelOverride);
      expect(rendered).toContain(successDetails.sessionName);
      expect(rendered).toContain(successDetails.sessionFile);
    });
  });
});
