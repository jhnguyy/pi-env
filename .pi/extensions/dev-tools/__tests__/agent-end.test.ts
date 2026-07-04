import { describe, expect, it } from "vitest";
import { BackendName } from "../backend-configs";
import type { DiagnosticsResult } from "../protocol";
import {
  type ActiveAgentEndResults,
  type AgentEndFileResult,
  AgentEndResultKind,
  diagnosticsToAgentEndResults,
  formatAgentEndErrorResult,
  processAgentEndResults,
  renderActiveAgentEndSummary,
  renderAgentEndSummary,
  shouldTriggerTurn,
  updateActiveAgentEndResults,
} from "../agent-end";

function result(filePath: string, message: string): AgentEndFileResult {
  return {
    kind: AgentEndResultKind.Lsp,
    backend: BackendName.TypeScript,
    filePath,
    fileName: filePath.split("/").pop() ?? filePath,
    issues: [{ severity: "error", line: 1, character: 1, code: "TS1", message }],
  };
}

describe("agent-end active result state", () => {
  it("renders a summary for result batches", () => {
    const summary = renderAgentEndSummary([result("/repo/a.ts", "broken")]);

    expect(summary).toContain("1 error");
    expect(summary).toContain("a.ts (typescript):");
    expect(summary).toContain("TS1 broken");
  });

  it("replaces stale issues for a file when latest diagnostics are clean", () => {
    const active: ActiveAgentEndResults = new Map();
    updateActiveAgentEndResults(active, ["/repo/a.ts"], [result("/repo/a.ts", "old error")]);
    expect(renderActiveAgentEndSummary(active)).toContain("old error");

    updateActiveAgentEndResults(active, ["/repo/a.ts"], []);

    expect(renderActiveAgentEndSummary(active)).toBe("");
  });

  it("keeps unrelated active issues while replacing only processed files", () => {
    const active: ActiveAgentEndResults = new Map();
    updateActiveAgentEndResults(active, ["/repo/a.ts", "/repo/b.ts"], [
      result("/repo/a.ts", "old a error"),
      result("/repo/b.ts", "b error"),
    ]);

    updateActiveAgentEndResults(active, ["/repo/a.ts"], [result("/repo/a.ts", "new a error")]);
    const summary = renderActiveAgentEndSummary(active);

    expect(summary).toContain("new a error");
    expect(summary).not.toContain("old a error");
    expect(summary).toContain("b error");
  });

  it("processes a batch into display, active context, and trigger decisions", () => {
    const active: ActiveAgentEndResults = new Map([["/repo/b.ts", result("/repo/b.ts", "b error")]]);

    const processed = processAgentEndResults(active, ["/repo/a.ts"], [result("/repo/a.ts", "a error")]);

    expect(processed.batchSummary).toContain("a error");
    expect(processed.batchSummary).not.toContain("b error");
    expect(processed.activeSummary).toContain("a error");
    expect(processed.activeSummary).toContain("b error");
    expect(processed.triggerTurn).toBe(true);
  });

  it("does not trigger a model turn for formatter errors", () => {
    const formatterResult = formatAgentEndErrorResult(BackendName.Terraform, "/repo/main.tf", "fmt failed");

    expect(shouldTriggerTurn([formatterResult])).toBe(false);
    expect(renderAgentEndSummary([formatterResult])).toContain("main.tf (terraform):");
  });

  it("maps diagnostics from items instead of trusting aggregate counts", () => {
    const diagnostics: DiagnosticsResult = {
      action: "diagnostics",
      path: "/repo/a.ts",
      errorCount: 0,
      warnCount: 0,
      language: "typescript",
      items: [{ severity: "error", line: 1, character: 1, code: "TS1", message: "count drift" }],
    };

    expect(diagnosticsToAgentEndResults(diagnostics)).toHaveLength(1);
  });

  it("renders active summaries in deterministic file-path order", () => {
    const active: ActiveAgentEndResults = new Map([
      ["/repo/z.ts", result("/repo/z.ts", "z error")],
      ["/repo/a.ts", result("/repo/a.ts", "a error")],
    ]);

    const summary = renderActiveAgentEndSummary(active);

    expect(summary.indexOf("a.ts")).toBeLessThan(summary.indexOf("z.ts"));
  });
});
