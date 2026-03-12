import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { renderDevToolsResult, renderDevToolsCall, type RenderTheme } from "../renderers";
import type { DiagnosticsResult, HoverResult, DefinitionResult, ReferencesResult, SymbolsResult, StatusResult } from "../protocol";

// ─── Mock theme ──────────────────────────────────────────────────────────────

const mockTheme: RenderTheme = {
  fg: (color: string, text: string) => `[${color}:${text}]`,
  bold: (text: string) => `**${text}**`,
};

function text(rendered: unknown): string {
  return (rendered as any).text as string;
}

describeIfEnabled("dev-tools", "Renderers", () => {
  // ─── renderDevToolsCall ───────────────────────────────────────────────────────

  describe("renderDevToolsCall", () => {
    it("includes tool title and action", () => {
      const t = text(renderDevToolsCall({ action: "diagnostics", path: "/project/src/foo.ts" }, mockTheme));
      expect(t).toContain("dev-tools");
      expect(t).toContain("diagnostics");
    });

    it("shows last 2 path segments", () => {
      const t = text(renderDevToolsCall({ action: "hover", path: "/project/src/foo.ts", line: 5, character: 10 }, mockTheme));
      expect(t).toContain("src/foo.ts");
      expect(t).toContain(":5");
    });

    it("shows query for workspace symbols", () => {
      const t = text(renderDevToolsCall({ action: "symbols", query: "User" }, mockTheme));
      expect(t).toContain('"User"');
    });
  });

  // ─── renderDevToolsResult — diagnostics ──────────────────────────────────────

  describe("renderDevToolsResult diagnostics", () => {
    const noDiags: DiagnosticsResult = {
      action: "diagnostics", path: "/a.ts", errorCount: 0, warnCount: 0, items: [],
    };

    const withErrors: DiagnosticsResult = {
      action: "diagnostics", path: "/a.ts", errorCount: 2, warnCount: 1,
      items: [
        { line: 5, character: 3, severity: "error", code: "TS2339", message: "Property 'x' does not exist." },
        { line: 7, character: 1, severity: "error", code: "TS2322", message: "Type 'number' not assignable." },
        { line: 12, character: 8, severity: "warning", code: "TS7006", message: "Implicit any." },
      ],
    };

    it("shows success for no errors", () => {
      const t = text(renderDevToolsResult({ isError: false, content: [], details: noDiags }, {}, mockTheme));
      expect(t).toContain("no errors");
      expect(t).toContain("success");
    });

    it("shows error count with error color", () => {
      const t = text(renderDevToolsResult({ isError: false, content: [], details: withErrors }, {}, mockTheme));
      expect(t).toContain("error");
      expect(t).toContain("2 errors");
    });

    it("expanded=true shows individual diagnostics", () => {
      const t = text(renderDevToolsResult(
        { isError: false, content: [], details: withErrors },
        { expanded: true },
        mockTheme,
      ));
      expect(t).toContain("L5:3");
      expect(t).toContain("TS2339");
      expect(t).toContain("L7:1");
    });

    it("expanded=false does not show individual diagnostics", () => {
      const t = text(renderDevToolsResult(
        { isError: false, content: [], details: withErrors },
        { expanded: false },
        mockTheme,
      ));
      expect(t).not.toContain("L5:3");
    });

    it("shows warning color when warnings present", () => {
      const r: DiagnosticsResult = { action: "diagnostics", path: "/a.ts", errorCount: 0, warnCount: 2, items: [
        { line: 1, character: 1, severity: "warning", code: "TS7006", message: "Implicit any." },
        { line: 2, character: 1, severity: "warning", code: "TS7006", message: "Implicit any." },
      ]};
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("warning");
    });
  });

  // ─── renderDevToolsResult — error state ───────────────────────────────────────

  describe("renderDevToolsResult error state", () => {
    it("shows error text on tool error", () => {
      const t = text(renderDevToolsResult({
        isError: true,
        content: [{ type: "text", text: "No hover information" }],
      }, {}, mockTheme));
      expect(t).toContain("error");
      expect(t).toContain("No hover information");
    });
  });

  // ─── renderDevToolsResult — other actions ────────────────────────────────────

  describe("renderDevToolsResult other actions", () => {
    it("renders hover success", () => {
      const r: HoverResult = { action: "hover", path: "/a.ts", line: 1, character: 1, signature: "string" };
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("hover");
    });

    it("renders definition with location count", () => {
      const r: DefinitionResult = {
        action: "definition", path: "/a.ts", line: 1, character: 1,
        locations: [
          { relativePath: "src/t.ts", absolutePath: "/p/src/t.ts", line: 1, body: "type T = string;" },
        ],
      };
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("1 location");
    });

    it("renders references with count", () => {
      const r: ReferencesResult = {
        action: "references", path: "/a.ts", line: 1, character: 1,
        total: 5, items: [], truncated: false,
      };
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("5 reference(s)");
    });

    it("renders symbols with count and filename", () => {
      const r: SymbolsResult = {
        action: "symbols", path: "/project/src/foo.ts",
        total: 7, items: [], truncated: false,
      };
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("7 symbols");
      expect(t).toContain("foo.ts");
    });

    it("renders workspace symbols with query", () => {
      const r: SymbolsResult = {
        action: "symbols", query: "User",
        total: 3, items: [], truncated: false,
      };
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("3 symbols");
      expect(t).toContain('"User"');
    });

    it("renders status running", () => {
      const r: StatusResult = {
        action: "status", running: true, pid: 1234,
        projects: [], openFiles: [], watchedFiles: 0, idleMs: 100,
      };
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("running");
      expect(t).toContain("1234");
    });

    it("renders status stopped", () => {
      const r: StatusResult = {
        action: "status", running: false, projects: [], openFiles: [], watchedFiles: 0, idleMs: 0,
      };
      const t = text(renderDevToolsResult({ isError: false, content: [], details: r }, {}, mockTheme));
      expect(t).toContain("stopped");
    });
  });
});
