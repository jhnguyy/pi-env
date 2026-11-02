import "./tui-setup";
import type { ExtensionAPI, KeybindingHints } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { componentText as renderedText, expansionHints } from "./rendering";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { renderTextToolResult } from "../_shared/tool-render";
import initDevTools from "../dev-tools/index";
import { createSubagentHarness } from "../subagent/__tests__/harness";
import { renderReviewResult } from "../review/render";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const options = { expanded: false, isPartial: false };
const result = { content: [{ type: "text" as const, text: "complete" }], details: {} };

interface CapturedTool {
  name: string;
  renderResult(
    result: AgentToolResult<Record<string, unknown>>,
    options: { expanded: boolean; isPartial?: boolean },
    renderTheme: typeof theme,
    context: KeybindingHints & { args?: { action: string } },
  ): Component;
}

function registeredDevTools(): CapturedTool {
  const tools: CapturedTool[] = [];
  initDevTools({
    registerTool: (tool: CapturedTool) => tools.push(tool),
    registerCommand() {},
    on() {},
    events: { on() {}, emit() {} },
  } as unknown as ExtensionAPI);
  const tool = tools.find((entry) => entry.name === "dev-tools");
  if (!tool) throw new Error("Expected registered tool: dev-tools");
  return tool;
}

const chains: Record<string, (hints: KeybindingHints, expanded: boolean) => Component> = {
  generic: (hints, expanded) =>
    renderTextToolResult("sample", result, { ...options, expanded }, theme, {
      ...hints,
      isError: false,
    }),
  review: (hints, expanded) =>
    renderReviewResult(result, { ...options, expanded }, theme, { ...hints, isError: false }),
  diagnostics: (hints, expanded) =>
    registeredDevTools().renderResult(
      { ...result, details: { action: "diagnostics", errorCount: 0, warnCount: 0, items: [] } },
      { ...options, expanded },
      theme,
      hints,
    ),
  subagent: (hints, expanded) =>
    createSubagentHarness()
      .tools.get("subagent")
      .renderResult({ ...result, details: { usage: {}, toolCallCount: 0 } }, { expanded }, theme, {
        ...hints,
        args: { action: "run" },
      }),
  jobs: (hints, expanded) =>
    createSubagentHarness()
      .tools.get("subagent")
      .renderResult(
        { ...result, details: { status: "completed", jobId: "job-1" } },
        { expanded },
        theme,
        { ...hints, args: { action: "result" } },
      ),
};

for (const [name, render] of Object.entries(chains)) {
  describe(`${name} injected hint chain`, () => {
    it("uses the host remapping only in collapsed output", () => {
      const hints = expansionHints("alt+e");
      const collapsed = renderedText(render(hints, false));
      expect(collapsed).toContain("alt+e");
      expect(collapsed).not.toContain("ctrl+o");
      expect(renderedText(render(hints, true))).not.toContain("alt+e");
    });

    it("does not invent a shortcut when expansion is disabled", () => {
      const disabled = expansionHints("");
      const collapsed = renderedText(render(disabled, false));
      expect(collapsed).not.toMatch(/to expand|for JSON|ctrl\+o|\(\)/u);
    });
  });
}
