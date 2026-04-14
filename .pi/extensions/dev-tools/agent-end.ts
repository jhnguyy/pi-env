/**
 * agent-end.ts — unified result type and renderer for agent_end post-edit processing.
 *
 * Both format backends (hclfmt, terraform fmt) and LSP backends (diagnostics)
 * produce AgentEndFileResult values. The dispatcher in index.ts collects them all
 * and calls renderAgentEndSummary once to produce a single consolidated message.
 *
 * Adding a new backend type? Make it produce AgentEndFileResult[] and push into
 * the shared allResults array. No other changes needed.
 */
import type { DiagnosticsResult, DiagnosticItem } from "./protocol";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single normalized issue from any backend. */
export interface AgentEndIssue {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-indexed. Absent for format errors which have no line info. */
  line?: number;
  /** 1-indexed. */
  character?: number;
  /** e.g. "TS2339" for TypeScript diagnostics. */
  code?: string;
}

/**
 * All issues found in one file by one backend at agent_end.
 * An empty issues array means the file was processed cleanly.
 */
export interface AgentEndFileResult {
  /** Backend name for display, e.g. "hcl", "terraform", "typescript", "bash" */
  backend: string;
  /** Absolute file path */
  filePath: string;
  /** Basename for display */
  fileName: string;
  /** Issues found. Empty → no problems. */
  issues: AgentEndIssue[];
  /**
   * When true, error-severity issues in this result cause the model to be
   * re-engaged via sendMessage({ triggerTurn: true }).
   * Format backends set this to false — their errors are informational.
   * LSP backends set this to true — errors need the model to fix them.
   */
  triggerOnError: boolean;
}

// ─── Decision ─────────────────────────────────────────────────────────────────

/**
 * Returns true if any result with triggerOnError has at least one error-severity
 * issue. Used to decide whether to pass { triggerTurn: true } to sendMessage.
 */
export function shouldTriggerTurn(results: AgentEndFileResult[]): boolean {
  return results.some(
    (r) => r.triggerOnError && r.issues.some((i) => i.severity === "error"),
  );
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapDiagItem(item: DiagnosticItem): AgentEndIssue {
  return {
    severity: item.severity === "error" ? "error"
      : item.severity === "warning" ? "warning"
      : "info",
    message: item.message,
    line: item.line,
    character: item.character,
    code: item.code || undefined,
  };
}

/**
 * Map a DiagnosticsResult (single file or bulk) to AgentEndFileResult[].
 * Files with no errors or warnings are omitted.
 */
export function diagnosticsToAgentEndResults(diags: DiagnosticsResult): AgentEndFileResult[] {
  const toResult = (path: string, language: string | undefined, items: DiagnosticItem[]): AgentEndFileResult => ({
    backend: language ?? "lsp",
    filePath: path,
    fileName: path.split("/").pop() ?? path,
    issues: items.map(mapDiagItem),
    triggerOnError: true,
  });

  if (diags.files) {
    // Bulk result — one entry per file that has issues
    return diags.files
      .filter((f) => f.errorCount > 0 || f.warnCount > 0)
      .map((f) => toResult(f.path, f.language ?? diags.language, f.items));
  }

  // Single-file result
  if (diags.errorCount === 0 && diags.warnCount === 0) return [];
  return [toResult(diags.path, diags.language, diags.items)];
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

/**
 * Render a summary of all agent_end results into a single string for the model.
 * Returns an empty string if there are no issues across all results.
 *
 * Format:
 *   N error(s), M warning(s)
 *   filename.ts (typescript):
 *     E L12:4 TS2339 Property 'x' does not exist
 *   main.hcl (hcl):
 *     E  Argument or block definition required
 */
export function renderAgentEndSummary(results: AgentEndFileResult[]): string {
  const withIssues = results.filter((r) => r.issues.length > 0);
  if (withIssues.length === 0) return "";

  let totalErrors = 0;
  let totalWarnings = 0;
  for (const r of withIssues) {
    for (const i of r.issues) {
      if (i.severity === "error") totalErrors++;
      else if (i.severity === "warning") totalWarnings++;
    }
  }

  const counts: string[] = [];
  if (totalErrors > 0) counts.push(`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`);
  if (totalWarnings > 0) counts.push(`${totalWarnings} warning${totalWarnings !== 1 ? "s" : ""}`);
  const lines: string[] = [counts.join(", ")];

  for (const r of withIssues) {
    lines.push(`${r.fileName} (${r.backend}):`);
    for (const issue of r.issues) {
      const prefix = issue.severity === "error" ? "E" : issue.severity === "warning" ? "W" : "I";
      const loc = issue.line != null ? ` L${issue.line}:${issue.character ?? 0}` : "";
      const code = issue.code ? ` ${issue.code}` : "";
      lines.push(`  ${prefix}${loc}${code} ${issue.message}`);
    }
  }

  return lines.join("\n");
}
