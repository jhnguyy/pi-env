/**
 * Formatters — convert LSP results to dense agent-first text.
 *
 * Principle: content is a machine-consumable payload sent to the LLM.
 * No decoration, no redundant labels, maximum information density.
 */

import type {
  LspResult,
  DiagnosticsResult,
  BulkDiagnosticsResult,
  HoverResult,
  DefinitionResult,
  ReferencesResult,
  SymbolsResult,
  StatusResult,
} from "./protocol";

// ─── Main entry ─────────────────────────────────────────────────────────────

/** Format an LSP result to a dense text string for LLM consumption. */
export function formatResult(result: LspResult): string {
  switch (result.action) {
    case "diagnostics":       return formatDiagnostics(result);
    case "bulk_diagnostics":  return formatBulkDiagnostics(result);
    case "hover":             return formatHover(result);
    case "definition":        return formatDefinition(result);
    case "references":        return formatReferences(result);
    case "symbols":           return formatSymbols(result);
    case "status":            return formatStatus(result);
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export function formatDiagnostics(r: DiagnosticsResult): string {
  if (r.errorCount === 0 && r.warnCount === 0) return "no errors";

  const lines: string[] = [];

  if (r.errorCount > 0 && r.warnCount > 0) {
    lines.push(`${r.errorCount} error${r.errorCount !== 1 ? "s" : ""}, ${r.warnCount} warning${r.warnCount !== 1 ? "s" : ""}`);
  } else if (r.errorCount > 0) {
    lines.push(`${r.errorCount} error${r.errorCount !== 1 ? "s" : ""}`);
  } else {
    lines.push(`${r.warnCount} warning${r.warnCount !== 1 ? "s" : ""}`);
  }

  for (const item of r.items) {
    const prefix = item.severity === "error" ? "E" : item.severity === "warning" ? "W" : "I";
    const code = item.code ? ` ${item.code}` : "";
    lines.push(`L${item.line}:${item.character} ${prefix}${code} ${item.message}`);
  }

  return lines.join("\n");
}

export function formatBulkDiagnostics(r: BulkDiagnosticsResult): string {
  const n = r.files.length;
  if (r.totalErrors === 0 && r.totalWarns === 0) {
    return `no errors across ${n} file${n !== 1 ? "s" : ""}`;
  }

  const summary =
    r.totalErrors > 0
      ? `${r.totalErrors} error${r.totalErrors !== 1 ? "s" : ""}` +
        (r.totalWarns ? `, ${r.totalWarns} warning${r.totalWarns !== 1 ? "s" : ""}` : "") +
        ` across ${n} file${n !== 1 ? "s" : ""}`
      : `${r.totalWarns} warning${r.totalWarns !== 1 ? "s" : ""} across ${n} file${n !== 1 ? "s" : ""}`;

  const parts: string[] = [summary];
  for (const file of r.files) {
    if (file.errorCount === 0 && file.warnCount === 0) continue;
    parts.push(`\n${file.path}:`);
    const detail = formatDiagnostics(file)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n");
    parts.push(detail);
  }

  return parts.join("\n");
}

/** Compact diagnostic summary for auto-append on edit/write. */
export function formatDiagnosticsSummary(r: DiagnosticsResult, maxItems = 5): string {
  if (r.errorCount === 0 && r.warnCount === 0) return "";

  let lang: string;
  switch (r.language) {
    case "bash": lang = "Bash"; break;
    case "nil":  lang = "Nix";  break;
    default:     lang = "TS";   break;
  }
  const label = r.errorCount > 0
    ? `⚠ ${lang} (${r.errorCount} error${r.errorCount !== 1 ? "s" : ""}${r.warnCount ? `, ${r.warnCount} warning${r.warnCount !== 1 ? "s" : ""}` : ""})`
    : `⚠ ${lang} (${r.warnCount} warning${r.warnCount !== 1 ? "s" : ""})`;

  const lines = [label];
  const shown = r.items.slice(0, maxItems);

  for (const item of shown) {
    const code = item.code ? ` ${item.code}` : "";
    lines.push(`L${item.line}:${item.character}${code} ${item.message}`);
  }

  const remaining = r.items.length - shown.length;
  if (remaining > 0) {
    lines.push(`... ${remaining} more — use dev-tools diagnostics for full list`);
  }

  return lines.join("\n");
}

// ─── Hover ──────────────────────────────────────────────────────────────────

export function formatHover(r: HoverResult): string {
  if (!r.docs) return r.signature;
  return `${r.signature}\n\n${r.docs}`;
}

// ─── Definition ─────────────────────────────────────────────────────────────

export function formatDefinition(r: DefinitionResult): string {
  if (r.locations.length === 0) return "No definition found";

  const parts: string[] = [];
  for (const loc of r.locations) {
    const header = `${loc.relativePath}:${loc.line}`;
    let body = loc.body;
    if (loc.truncatedLines && loc.truncatedLines > 0) {
      body += `\n... (${loc.truncatedLines} more lines)`;
    }
    parts.push(`${header}\n${body}`);
  }

  return parts.join("\n\n");
}

// ─── References ─────────────────────────────────────────────────────────────

export function formatReferences(r: ReferencesResult): string {
  if (r.total === 0) return "no references";

  const lines: string[] = [];
  lines.push(`${r.total} reference${r.total !== 1 ? "s" : ""}`);

  for (const item of r.items) {
    lines.push(`${item.relativePath}:${item.line} ${item.content}`);
  }

  if (r.truncated) {
    lines.push(`... ${r.total - r.items.length} more`);
  }

  return lines.join("\n");
}

// ─── Symbols ────────────────────────────────────────────────────────────────

export function formatSymbols(r: SymbolsResult): string {
  if (r.total === 0) return "no symbols";

  const lines: string[] = [];
  lines.push(`${r.total} symbol${r.total !== 1 ? "s" : ""}`);

  for (const item of r.items) {
    if (r.path) {
      // Document symbols: L<line> <kind> <name>[: <detail>]
      const detail = item.detail ? `: ${item.detail}` : "";
      lines.push(`L${item.line} ${item.kind} ${item.name}${detail}`);
    } else {
      // Workspace symbols: <relativePath>:<line> <kind> <name>
      lines.push(`${item.relativePath}:${item.line} ${item.kind} ${item.name}`);
    }
  }

  if (r.truncated) {
    lines.push(`... (truncated)`);
  }

  return lines.join("\n");
}

// ─── Status ─────────────────────────────────────────────────────────────────

export function formatStatus(r: StatusResult): string {
  const lines: string[] = [];
  lines.push(`LSP daemon ${r.running ? "running" : "stopped"}`);
  if (r.pid) lines.push(`PID: ${r.pid}`);
  lines.push(`Projects: ${r.projects.length === 0 ? "none" : r.projects.join(", ")}`);
  if (r.openFiles.length === 0) {
    lines.push("Open files: none");
  } else {
    lines.push(`Open files (${r.openFiles.length}):`);
    for (const f of r.openFiles) lines.push(`  ${f}`);
  }
  lines.push(`Idle: ${Math.round(r.idleMs / 1000)}s`);
  return lines.join("\n");
}
