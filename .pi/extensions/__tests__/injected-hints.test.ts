import "./tui-setup";
import type { KeybindingHints } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderTextToolResult } from "../_shared/tool-render";
import initDevTools from "../dev-tools/index";
import initSubagent from "../subagent/index";
import { renderReviewResult } from "../review/render";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const options = { expanded: false, isPartial: false };
const result = { content: [{ type: "text" as const, text: "complete" }], details: {} };

function registeredTool(init: (pi: any) => void, name: string): any {
  const tools: any[] = [];
  init({
    registerTool: (tool: any) => tools.push(tool),
    registerCommand() {},
    on() {},
    events: { on() {}, emit() {} },
  });
  return tools.find((tool) => tool.name === name);
}

function renderedText(component: any): string {
  return component.children
    ? component.children.map(renderedText).join("\n")
    : (component.text ?? component.render(500).join("\n"));
}

const devTools = registeredTool(initDevTools, "dev-tools");
const subagent = registeredTool(initSubagent, "subagent");

const chains: Record<string, (hints: KeybindingHints, expanded: boolean) => unknown> = {
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
