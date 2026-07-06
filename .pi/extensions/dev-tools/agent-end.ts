/**
 * agent-end.ts — unified result type and renderer for agent_end post-edit processing.
 *
 * Both format backends (hclfmt, terraform fmt) and LSP backends (diagnostics)
 * produce AgentEndFileResult values. The lifecycle dispatcher collects them all
 * and calls renderAgentEndSummary once to produce a single consolidated message.
 *
 * Adding a new backend type? Make it produce AgentEndFileResult[] and push into
 * the shared allResults array. Use the result `kind` to encode backend policy.
 */
import { basename } from "node:path";
import type { DiagnosticsResult, DiagnosticItem } from "./protocol";
import { BackendName } from "./backend-configs";

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single normalized issue from any backend. */
export const AgentEndResultKind = {
  Lsp: "lsp",
  Format: "format",
} as const;
export type AgentEndResultKind = typeof AgentEndResultKind[keyof typeof AgentEndResultKind];

export const AgentEndIssueSeverity = {
  Error: "error",
  Warning: "warning",
  Info: "info",
} as const;
export type AgentEndIssueSeverity = typeof AgentEndIssueSeverity[keyof typeof AgentEndIssueSeverity];

export interface AgentEndIssue {
  severity: AgentEndIssueSeverity;
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
interface AgentEndFileResultBase {
  /** Backend name for display, e.g. "hcl", "terraform", "typescript", "bash" */
  backend: BackendName;
  /** Absolute file path */
  filePath: string;
  /** Basename for display */
  fileName: string;
  /** Issues found. Empty → no problems. */
  issues: AgentEndIssue[];
}

/** LSP diagnostics can re-engage the model when they contain errors. */
export interface LspAgentEndFileResult extends AgentEndFileResultBase {
  kind: typeof AgentEndResultKind.Lsp;
}

/** Formatter failures are shown to the user but do not re-engage the model. */
export interface FormatAgentEndFileResult extends AgentEndFileResultBase {
  kind: typeof AgentEndResultKind.Format;
}

export type AgentEndFileResult = LspAgentEndFileResult | FormatAgentEndFileResult;

// ─── Decision ─────────────────────────────────────────────────────────────────

/**
 * Returns true if any LSP result has at least one error-severity issue. Used to
 * decide whether to pass { triggerTurn: true } to sendMessage.
 */
export interface AgentEndIssueCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countAgentEndIssues(results: AgentEndFileResult[]): AgentEndIssueCounts {
  const counts: AgentEndIssueCounts = { errors: 0, warnings: 0, infos: 0 };
  for (const result of results) {
    for (const issue of result.issues) {
      switch (issue.severity) {
        case AgentEndIssueSeverity.Error:
          counts.errors++;
          break;
        case AgentEndIssueSeverity.Warning:
          counts.warnings++;
          break;
        case AgentEndIssueSeverity.Info:
          counts.infos++;
          break;
      }
    }
  }
  return counts;
}

export function shouldTriggerTurn(results: AgentEndFileResult[]): boolean {
  return results.some(
    (r) => r.kind === AgentEndResultKind.Lsp &&
      r.issues.some((i) => i.severity === AgentEndIssueSeverity.Error),
  );
}

// ─── Active state ─────────────────────────────────────────────────────────────
/**
 * Mutable active diagnostics state keyed by file path.
 *
 * agent_end backends often omit clean files, so callers must pass every file that
 * was actually processed. Those files are first removed from the active set, then
 * any newly reported issues are inserted. This lets a later clean write retire a
 * stale diagnostic instead of leaving old post-edit messages in model context.
 */
export type ActiveAgentEndResults = Map<string, AgentEndFileResult>;

export function updateActiveAgentEndResults(
  active: ActiveAgentEndResults,
  processedFiles: string[],
  latestResults: AgentEndFileResult[],
): void {
  for (const file of processedFiles) active.delete(file);
  for (const result of latestResults) {
    if (result.issues.length > 0) active.set(result.filePath, result);
  }
}

/** Return active results in deterministic file-path order. */
export function sortedActiveAgentEndResults(active: ActiveAgentEndResults): AgentEndFileResult[] {
  return [...active.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Render the current active state in stable file-path order. */
export function renderActiveAgentEndSummary(active: ActiveAgentEndResults): string {
  return renderAgentEndSummary(sortedActiveAgentEndResults(active));
}

export interface AgentEndProcessingResult {
  /** Summary for just this agent_end batch, used for displayed follow-up messages. */
  batchSummary: string;
  /** Summary for all currently active issues, used for LLM context injection. */
  activeSummary: string;
  /** Whether this batch should start a synthetic fix-up turn. */
  triggerTurn: boolean;
}

export function processAgentEndResults(
  active: ActiveAgentEndResults,
  processedFiles: string[],
  latestResults: AgentEndFileResult[],
): AgentEndProcessingResult {
  updateActiveAgentEndResults(active, processedFiles, latestResults);
  return {
    batchSummary: renderAgentEndSummary(latestResults),
    activeSummary: renderActiveAgentEndSummary(active),
    triggerTurn: shouldTriggerTurn(latestResults),
  };
}

export function formatAgentEndErrorResult(
  backend: BackendName,
  filePath: string,
  message: string,
): FormatAgentEndFileResult {
  return {
    kind: AgentEndResultKind.Format,
    backend,
    filePath,
    fileName: basename(filePath),
    issues: [{ severity: AgentEndIssueSeverity.Error, message }],
  };
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapDiagItem(item: DiagnosticItem): AgentEndIssue {
  let severity: AgentEndIssueSeverity;
  switch (item.severity) {
    case "error":
      severity = AgentEndIssueSeverity.Error;
      break;
    case "warning":
      severity = AgentEndIssueSeverity.Warning;
      break;
    default:
      severity = AgentEndIssueSeverity.Info;
      break;
  }

  return {
    severity,
    message: item.message,
    line: item.line,
    character: item.character,
    code: item.code || undefined,
  };
}

function hasReportableDiagnostics(items: DiagnosticItem[]): boolean {
  return items.some((item) => item.severity === "error" || item.severity === "warning");
}

function backendName(value: string | undefined): BackendName | undefined {
  if (!value) return undefined;
  return Object.values(BackendName).includes(value as BackendName) ? value as BackendName : BackendName.Lsp;
}

/**
 * Map a DiagnosticsResult (single file or bulk) to AgentEndFileResult[].
 * Files with no errors or warnings are omitted.
 */
export function diagnosticsToAgentEndResults(diags: DiagnosticsResult): AgentEndFileResult[] {
  const toResult = (path: string, language: BackendName | undefined, items: DiagnosticItem[]): AgentEndFileResult => ({
    kind: AgentEndResultKind.Lsp,
    backend: language ?? BackendName.Lsp,
    filePath: path,
    fileName: basename(path),
    issues: items.map(mapDiagItem),
  });

  if (diags.files) {
    // Bulk result — one entry per file that has reportable issues.
    return diags.files
      .filter((f) => hasReportableDiagnostics(f.items))
      .map((f) => toResult(f.path, backendName(f.language ?? diags.language), f.items));
  }

  // Single-file result
  if (!hasReportableDiagnostics(diags.items)) return [];
  return [toResult(diags.path, backendName(diags.language), diags.items)];
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
      switch (i.severity) {
        case AgentEndIssueSeverity.Error:
          totalErrors++;
          break;
        case AgentEndIssueSeverity.Warning:
          totalWarnings++;
          break;
        case AgentEndIssueSeverity.Info:
          break;
      }
    }
  }

  const counts: string[] = [];
  if (totalErrors > 0) counts.push(`${totalErrors} error${totalErrors !== 1 ? "s" : ""}`);
  if (totalWarnings > 0) counts.push(`${totalWarnings} warning${totalWarnings !== 1 ? "s" : ""}`);
  const lines: string[] = [counts.join(", ")];

  for (const r of withIssues) {
    lines.push(`${r.fileName} (${r.backend}):`);
    for (const issue of r.issues) {
      let prefix: string;
      switch (issue.severity) {
        case AgentEndIssueSeverity.Error:
          prefix = "E";
          break;
        case AgentEndIssueSeverity.Warning:
          prefix = "W";
          break;
        case AgentEndIssueSeverity.Info:
          prefix = "I";
          break;
      }
      const loc = issue.line != null ? ` L${issue.line}:${issue.character ?? 0}` : "";
      const code = issue.code ? ` ${issue.code}` : "";
      lines.push(`  ${prefix}${loc}${code} ${issue.message}`);
    }
  }

  return lines.join("\n");
}
