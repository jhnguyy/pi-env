import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import {
  formatResult,
  formatDiagnostics,
  formatDiagnosticsSummary,
  formatHover,
  formatDefinition,
  formatReferences,
  formatSymbols,
  formatStatus,
} from "../formatters";
import type {
  DiagnosticsResult, HoverResult, DefinitionResult,
  ReferencesResult, SymbolsResult, StatusResult,
} from "../protocol";

describeIfEnabled("lsp", "Formatters", () => {
  // ─── formatDiagnostics ─────────────────────────────────────────────────────

  describe("formatDiagnostics", () => {
    const noErrors: DiagnosticsResult = {
      action: "diagnostics", path: "/a.ts", errorCount: 0, warnCount: 0, items: [],
    };

    const withErrors: DiagnosticsResult = {
      action: "diagnostics",
      path: "/a.ts",
      errorCount: 2,
      warnCount: 1,
      items: [
        { line: 5, character: 33, severity: "error", code: "TS2339", message: "Property 'age' does not exist on type 'User'." },
        { line: 6, character: 7, severity: "error", code: "TS2322", message: "Type 'string' is not assignable to type 'number'." },
        { line: 12, character: 1, severity: "warning", code: "TS7006", message: "Parameter 'x' implicitly has an 'any' type." },
      ],
    };

    it("returns 'no errors' when clean", () => {
      expect(formatDiagnostics(noErrors)).toBe("no errors");
    });

    it("includes count header with error and warning counts", () => {
      const text = formatDiagnostics(withErrors);
      expect(text).toContain("2 errors, 1 warning");
    });

    it("formats each item with line:col prefix", () => {
      const text = formatDiagnostics(withErrors);
      expect(text).toContain("L5:33 E TS2339");
      expect(text).toContain("L6:7 E TS2322");
      expect(text).toContain("L12:1 W TS7006");
    });

    it("error-only count: singular", () => {
      const r: DiagnosticsResult = { ...noErrors, errorCount: 1, items: [withErrors.items[0]!] };
      expect(formatDiagnostics(r)).toContain("1 error");
      expect(formatDiagnostics(r)).not.toContain("errors");
    });

    it("warning-only count", () => {
      const r: DiagnosticsResult = { ...noErrors, warnCount: 3, items: [
        { line: 1, character: 1, severity: "warning", code: "TS7017", message: "Element has any type." },
        { line: 2, character: 1, severity: "warning", code: "TS7017", message: "Element has any type." },
        { line: 3, character: 1, severity: "warning", code: "TS7017", message: "Element has any type." },
      ]};
      expect(formatDiagnostics(r)).toContain("3 warnings");
    });
  });

  // ─── formatDiagnosticsSummary ──────────────────────────────────────────────

  describe("formatDiagnosticsSummary", () => {
    it("returns empty string when no errors or warnings", () => {
      const r: DiagnosticsResult = { action: "diagnostics", path: "/a.ts", errorCount: 0, warnCount: 0, items: [] };
      expect(formatDiagnosticsSummary(r)).toBe("");
    });

    it("shows ⚠ TS header with count", () => {
      const r: DiagnosticsResult = {
        action: "diagnostics", path: "/a.ts", errorCount: 2, warnCount: 0,
        items: [
          { line: 1, character: 1, severity: "error", code: "TS2339", message: "Error A." },
          { line: 2, character: 1, severity: "error", code: "TS2322", message: "Error B." },
        ],
      };
      const text = formatDiagnosticsSummary(r);
      expect(text).toContain("⚠ TS (2 errors)");
    });

    it("truncates to maxItems and shows '... N more' suffix", () => {
      const items = Array.from({ length: 8 }, (_, i) => ({
        line: i + 1, character: 1, severity: "error" as const, code: `TS${i}`, message: `Error ${i}.`,
      }));
      const r: DiagnosticsResult = { action: "diagnostics", path: "/a.ts", errorCount: 8, warnCount: 0, items };
      const text = formatDiagnosticsSummary(r, 5);
      expect(text).toContain("... 3 more — use lsp diagnostics for full list");
      const lineCount = text.split("\n").length;
      expect(lineCount).toBe(7); // header + 5 items + truncation line
    });
  });

  // ─── formatHover ──────────────────────────────────────────────────────────

  describe("formatHover", () => {
    it("returns signature only when no docs", () => {
      const r: HoverResult = {
        action: "hover", path: "/a.ts", line: 5, character: 10,
        signature: "(property) User.name: string",
      };
      expect(formatHover(r)).toBe("(property) User.name: string");
    });

    it("appends docs separated by blank line", () => {
      const r: HoverResult = {
        action: "hover", path: "/a.ts", line: 5, character: 10,
        signature: "(property) User.name: string",
        docs: "The user's display name.",
      };
      const text = formatHover(r);
      expect(text).toBe("(property) User.name: string\n\nThe user's display name.");
    });
  });

  // ─── formatDefinition ─────────────────────────────────────────────────────

  describe("formatDefinition", () => {
    it("returns 'No definition found' for empty locations", () => {
      const r: DefinitionResult = {
        action: "definition", path: "/a.ts", line: 5, character: 10, locations: [],
      };
      expect(formatDefinition(r)).toBe("No definition found");
    });

    it("formats single definition with path:line header and body", () => {
      const r: DefinitionResult = {
        action: "definition", path: "/a.ts", line: 5, character: 10,
        locations: [{
          relativePath: "src/types.ts",
          absolutePath: "/project/src/types.ts",
          line: 1,
          body: "interface User {\n  name: string;\n  age: number;\n}",
        }],
      };
      const text = formatDefinition(r);
      expect(text).toContain("src/types.ts:1");
      expect(text).toContain("interface User {");
      expect(text).toContain("  name: string;");
    });

    it("appends truncation note when truncatedLines > 0", () => {
      const r: DefinitionResult = {
        action: "definition", path: "/a.ts", line: 1, character: 1,
        locations: [{
          relativePath: "src/big.ts",
          absolutePath: "/project/src/big.ts",
          line: 1,
          body: "class Big {\n  // ...\n}",
          truncatedLines: 50,
        }],
      };
      const text = formatDefinition(r);
      expect(text).toContain("... (50 more lines)");
    });

    it("formats multiple definitions separated by blank lines", () => {
      const r: DefinitionResult = {
        action: "definition", path: "/a.ts", line: 1, character: 1,
        locations: [
          { relativePath: "src/a.ts", absolutePath: "/project/src/a.ts", line: 1, body: "type A = string;" },
          { relativePath: "src/b.ts", absolutePath: "/project/src/b.ts", line: 5, body: "type A = number;" },
        ],
      };
      const text = formatDefinition(r);
      expect(text).toContain("src/a.ts:1");
      expect(text).toContain("src/b.ts:5");
    });
  });

  // ─── formatReferences ──────────────────────────────────────────────────────

  describe("formatReferences", () => {
    it("returns 'no references' for empty results", () => {
      const r: ReferencesResult = {
        action: "references", path: "/a.ts", line: 1, character: 1,
        total: 0, items: [], truncated: false,
      };
      expect(formatReferences(r)).toBe("no references");
    });

    it("includes count and items", () => {
      const r: ReferencesResult = {
        action: "references", path: "/a.ts", line: 1, character: 1,
        total: 3,
        items: [
          { relativePath: "src/a.ts", absolutePath: "/project/src/a.ts", line: 12, content: "const x = greet(user);" },
          { relativePath: "src/b.ts", absolutePath: "/project/src/b.ts", line: 5, content: "greet(admin);" },
          { relativePath: "test/a.test.ts", absolutePath: "/project/test/a.test.ts", line: 8, content: "expect(greet(u)).toBe('hi');" },
        ],
        truncated: false,
      };
      const text = formatReferences(r);
      expect(text).toContain("3 references");
      expect(text).toContain("src/a.ts:12 const x = greet(user);");
      expect(text).toContain("src/b.ts:5 greet(admin);");
    });

    it("appends truncation note when truncated", () => {
      const items = Array.from({ length: 20 }, (_, i) => ({
        relativePath: `src/${i}.ts`,
        absolutePath: `/project/src/${i}.ts`,
        line: i + 1,
        content: `usage ${i}`,
      }));
      const r: ReferencesResult = {
        action: "references", path: "/a.ts", line: 1, character: 1,
        total: 35, items, truncated: true,
      };
      const text = formatReferences(r);
      expect(text).toContain("35 references");
      expect(text).toContain("... 15 more");
    });

    it("singular 'reference' for count=1", () => {
      const r: ReferencesResult = {
        action: "references", path: "/a.ts", line: 1, character: 1,
        total: 1,
        items: [{ relativePath: "a.ts", absolutePath: "/a.ts", line: 1, content: "fn()" }],
        truncated: false,
      };
      expect(formatReferences(r)).toContain("1 reference");
      expect(formatReferences(r)).not.toContain("1 references");
    });
  });

  // ─── formatSymbols ─────────────────────────────────────────────────────────

  describe("formatSymbols", () => {
    it("returns 'no symbols' for empty results", () => {
      const r: SymbolsResult = { action: "symbols", path: "/a.ts", total: 0, items: [], truncated: false };
      expect(formatSymbols(r)).toBe("no symbols");
    });

    it("formats document symbols with L<line> prefix", () => {
      const r: SymbolsResult = {
        action: "symbols", path: "/a.ts",
        total: 3,
        items: [
          { line: 1, name: "User", kind: "interface" },
          { line: 2, name: "name", kind: "property", detail: "string" },
          { line: 6, name: "greet", kind: "function" },
        ],
        truncated: false,
      };
      const text = formatSymbols(r);
      expect(text).toContain("3 symbols");
      expect(text).toContain("L1 interface User");
      expect(text).toContain("L2 property name: string");
      expect(text).toContain("L6 function greet");
    });

    it("formats workspace symbols with relativePath:line prefix", () => {
      const r: SymbolsResult = {
        action: "symbols", query: "User",
        total: 2,
        items: [
          { line: 1, name: "User", kind: "interface", relativePath: "src/types.ts", absolutePath: "/project/src/types.ts" },
          { line: 15, name: "UserInput", kind: "type parameter", relativePath: "src/forms.ts", absolutePath: "/project/src/forms.ts" },
        ],
        truncated: false,
      };
      const text = formatSymbols(r);
      expect(text).toContain("2 symbols");
      expect(text).toContain("src/types.ts:1 interface User");
      expect(text).toContain("src/forms.ts:15 type parameter UserInput");
    });
  });

  // ─── formatStatus ──────────────────────────────────────────────────────────

  describe("formatStatus", () => {
    it("formats running daemon status", () => {
      const r: StatusResult = {
        action: "status", running: true, pid: 12345,
        projects: ["/project/a", "/project/b"],
        openFiles: ["/project/a/src/index.ts", "/project/a/src/client.ts"],
        watchedFiles: 2, idleMs: 5000,
      };
      const text = formatStatus(r);
      expect(text).toContain("LSP daemon running");
      expect(text).toContain("PID: 12345");
      expect(text).toContain("/project/a");
      expect(text).toContain("Open files (2):");
      expect(text).toContain("/project/a/src/index.ts");
      expect(text).toContain("/project/a/src/client.ts");
      expect(text).toContain("Idle: 5s");
    });

    it("formats stopped daemon status", () => {
      const r: StatusResult = {
        action: "status", running: false, projects: [], openFiles: [], watchedFiles: 0, idleMs: 0,
      };
      const text = formatStatus(r);
      expect(text).toContain("LSP daemon stopped");
      expect(text).toContain("Open files: none");
    });
  });

  // ─── formatResult dispatch ─────────────────────────────────────────────────

  describe("formatResult", () => {
    it("dispatches to correct formatter", () => {
      const r: DiagnosticsResult = {
        action: "diagnostics", path: "/a.ts", errorCount: 0, warnCount: 0, items: [],
      };
      expect(formatResult(r)).toBe("no errors");
    });
  });
});
