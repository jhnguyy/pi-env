import "../../__tests__/tui-setup";
import { describe, expect, it } from "vitest";
import { componentText as text, expansionHints } from "../../__tests__/rendering";
import { renderDevToolsCall, type RenderTheme } from "../renderers";
import { registerDevTools } from "../index";
import type { DiagnosticsResult } from "../protocol";

const mockTheme: RenderTheme = {
  fg: (color, value) => `[${color}:${value}]`,
  bold: (value) => `**${value}**`,
};

const tools: any[] = [];
registerDevTools({
  registerCommand() {},
  registerTool: (tool: any) => tools.push(tool),
} as any);
const tool = tools.find((entry) => entry.name === "dev-tools");
const context = { ...expansionHints, isError: false };

const diagnostics: DiagnosticsResult = {
  action: "diagnostics",
  path: "/a.ts",
  errorCount: 2,
  warnCount: 1,
  items: [
    {
      line: 5,
      character: 3,
      severity: "error",
      code: "TS2339",
      message: "Property 'x' does not exist.",
    },
    {
      line: 7,
      character: 1,
      severity: "error",
      code: "TS2322",
      message: "Type 'number' not assignable.",
    },
    { line: 12, character: 8, severity: "warning", code: "TS7006", message: "Implicit any." },
  ],
};

describe("dev-tools renderers", () => {
  it("shows compact paths, queries, and rename targets", () => {
    const call = text(
      renderDevToolsCall(
        {
          action: "rename",
          path: "/project/src/foo.ts",
          line: 5,
          character: 10,
          newName: "updatedName",
        },
        mockTheme,
      ),
    );
    expect(call).toContain("src/foo.ts");
    expect(call).toContain("updatedName");
    expect(call).not.toContain("/project/");
    expect(text(renderDevToolsCall({ action: "symbols", query: "User" }, mockTheme))).toContain(
      '"User"',
    );
  });

  it("dispatches diagnostics, hiding details until expanded", () => {
    const result = { content: [], details: diagnostics };
    const collapsed = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, mockTheme, context),
    );
    expect(collapsed).toMatch(/\[error:[^\]]*2 errors/u);
    expect(collapsed).toMatch(/\[warning:[^\]]*1 warning/u);
    expect(collapsed).not.toMatch(/TS2339|Property 'x'/u);
    const expanded = text(
      tool.renderResult(result, { expanded: true, isPartial: false }, mockTheme, context),
    );
    expect(expanded).toContain('"line": 5');
    expect(expanded).toContain('"code": "TS2339"');
  });

  it("shows success and the bounded scanned-file summary", () => {
    const details: DiagnosticsResult = {
      action: "diagnostics",
      path: "(bulk)",
      errorCount: 0,
      warnCount: 0,
      items: [],
      files: ["src/a.ts", "test/b.ts", "lib/c.ts", "lib/d.ts"].map((path) => ({
        action: "diagnostics",
        path: `/repo/${path}`,
        errorCount: 0,
        warnCount: 0,
        items: [],
      })),
    };
    const rendered = text(
      tool.renderResult({ content: [], details }, { expanded: false }, mockTheme, context),
    );
    expect(rendered).toContain("no errors");
    expect(rendered).toContain("scanned 4 files: src/a.ts, test/b.ts, lib/c.ts, +1 more");
  });

  it("uses host context error authority for a native result without isError", () => {
    const result = { content: [{ type: "text", text: "daemon unavailable" }], details: null };
    const rendered = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, mockTheme, {
        ...context,
        isError: true,
      }),
    );
    expect(rendered).toMatch(/\[error:[^\]]*daemon unavailable/u);
    const ordinary = text(tool.renderResult(result, { expanded: false }, mockTheme, context));
    expect(ordinary).toContain("daemon unavailable");
    expect(ordinary).not.toContain("[error:");
  });
});
