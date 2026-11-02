import "./tui-setup";
import type { ExtensionAPI, KeybindingHints } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { renderTextToolResult } from "../_shared/tool-render";
import initDevTools from "../dev-tools/index";
import initSubagent from "../subagent/index";
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

function registeredTool(init: (pi: ExtensionAPI) => void, name: string): CapturedTool {
  const tools: CapturedTool[] = [];
  init({
    registerTool: (tool: CapturedTool) => tools.push(tool),
    registerCommand() {},
    on() {},
    events: { on() {}, emit() {} },
  } as unknown as ExtensionAPI);
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Expected registered tool: ${name}`);
  return tool;
}

function renderedText(component: Component): string {
  return stripTerminalSequences(component.render(500).join("\n"));
}

const devTools = registeredTool(initDevTools, "dev-tools");
const subagent = registeredTool(initSubagent, "subagent");

const chains: Record<string, (hints: KeybindingHints, expanded: boolean) => Component> = {
  generic: (hints, expanded) =>
    renderTextToolResult("sample", result, { ...options, expanded }, theme, {
      ...hints,
      isError: false,
    }),
  review: (hints, expanded) =>
    renderReviewResult(result, { ...options, expanded }, theme, { ...hints, isError: false }),
  diagnostics: (hints, expanded) =>
    devTools.renderResult(
      { ...result, details: { action: "diagnostics", errorCount: 0, warnCount: 0, items: [] } },
      { ...options, expanded },
      theme,
      hints,
    ),
  subagent: (hints, expanded) =>
    subagent.renderResult(
      { ...result, details: { usage: {}, toolCallCount: 0 } },
      { expanded },
      theme,
      { ...hints, args: { action: "run" } },
    ),
  jobs: (hints, expanded) =>
    subagent.renderResult(
      { ...result, details: { status: "completed", jobId: "job-1" } },
      { expanded },
      theme,
      { ...hints, args: { action: "result" } },
    ),
};

for (const [name, render] of Object.entries(chains)) {
  describe(`${name} injected hint chain`, () => {
    it("uses the host remapping only in collapsed output", () => {
      const hints: KeybindingHints = {
        keyText: (id) => (id === "app.tools.expand" ? "alt+e" : ""),
        keyHint: (id, description) => {
          expect(id).toBe("app.tools.expand");
          return `alt+e ${description}`;
        },
      };
      const collapsed = renderedText(render(hints, false));
      expect(collapsed).toContain("alt+e");
      expect(collapsed).not.toContain("ctrl+o");
      expect(renderedText(render(hints, true))).not.toContain("alt+e");
    });

    it("does not invent a shortcut when expansion is disabled", () => {
      const disabled: KeybindingHints = {
        keyText: () => "",
        keyHint: () => {
          throw new Error("Disabled key must not be formatted");
        },
      };
      const collapsed = renderedText(render(disabled, false));
      expect(collapsed).not.toMatch(/to expand|for JSON|ctrl\+o|\(\)/u);
    });
  });
}
