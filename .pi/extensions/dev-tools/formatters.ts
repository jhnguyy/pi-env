/**
 * Formatters — convert LSP results to dense agent-first text.
 *
 * Principle: content is a machine-consumable payload sent to the LLM.
 * No decoration, no redundant labels, maximum information density.
 */

import type {
  LspResult,
  DiagnosticsResult,
  HoverResult,
  DefinitionResult,
  ImplementationResult,
  ReferencesResult,
  IncomingCallsResult,
  OutgoingCallsResult,
  SymbolsResult,
  StatusResult,
} from "./protocol";

// ─── Main entry ─────────────────────────────────────────────────────────────

/** Format an LSP result to a dense text string for LLM consumption. */
export function formatResult(result: LspResult): string {
  switch (result.action) {
    case "diagnostics":    return formatDiagnostics(result);
    case "hover":          return formatHover(result);
    case "definition":     return formatDefinition(result);
    case "implementation": return formatImplementation(result);
    case "references":     return formatReferences(result);
    case "incoming-calls": return formatIncomingCalls(result);
    case "outgoing-calls": return formatOutgoingCalls(result);
    case "symbols":        return formatSymbols(result);
    case "status":         return formatStatus(result);
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export function formatDiagnostics(r: DiagnosticsResult): string {
  // ── Bulk result (files[] present) ────────────────────────────────────────
  if (r.files) {
    return formatBulkDiagnostics(r);
  }

  // ── Single file ──────────────────────────────────────────────────────────
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

function formatBulkDiagnostics(r: DiagnosticsResult): string {
  const files = r.files!;
  const n = files.length + (r.fileErrors?.length ?? 0);

  const parts: string[] = [];

  // Summary line
  if (r.errorCount === 0 && r.warnCount === 0 && !r.fileErrors?.length) {
    parts.push(`no errors across ${n} file${n !== 1 ? "s" : ""}`);
  } else {
    const counts: string[] = [];
    if (r.errorCount > 0) counts.push(`${r.errorCount} error${r.errorCount !== 1 ? "s" : ""}`);
    if (r.warnCount > 0) counts.push(`${r.warnCount} warning${r.warnCount !== 1 ? "s" : ""}`);
    if (r.fileErrors?.length) counts.push(`${r.fileErrors.length} failed`);
    parts.push(`${counts.join(", ")} across ${n} file${n !== 1 ? "s" : ""}`);
  }

  // Per-file items (only files with issues)
  for (const file of files) {
    if (file.errorCount === 0 && file.warnCount === 0) continue;
    parts.push(`${file.path}:`);
    for (const item of file.items) {
      const prefix = item.severity === "error" ? "E" : item.severity === "warning" ? "W" : "I";
      const code = item.code ? ` ${item.code}` : "";
      parts.push(`  L${item.line}:${item.character} ${prefix}${code} ${item.message}`);
    }
  }

  // File-level errors (not found, etc.)
  if (r.fileErrors?.length) {
    for (const err of r.fileErrors) {
      parts.push(`FAILED: ${err}`);
    }
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

// ─── Implementation ─────────────────────────────────────────────────────────

export function formatImplementation(r: ImplementationResult): string {
  if (r.locations.length === 0) return "No implementations found";

  const parts: string[] = [];
  parts.push(`${r.locations.length} implementation${r.locations.length !== 1 ? "s" : ""}`);
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

// ─── Call Hierarchy ─────────────────────────────────────────────────────────

export function formatIncomingCalls(r: IncomingCallsResult): string {
  if (r.total === 0) return `no callers of ${r.symbol}`;

  const lines: string[] = [];
  lines.push(`${r.total} caller${r.total !== 1 ? "s" : ""} of ${r.symbol}`);

  for (const item of r.items) {
    lines.push(`${item.relativePath}:${item.line} ${item.kind} ${item.name} — ${item.content}`);
  }

  if (r.truncated) {
    lines.push(`... ${r.total - r.items.length} more`);
  }

  return lines.join("\n");
}

export function formatOutgoingCalls(r: OutgoingCallsResult): string {
  if (r.total === 0) return `${r.symbol} makes no calls`;

  const lines: string[] = [];
  lines.push(`${r.symbol} calls ${r.total} function${r.total !== 1 ? "s" : ""}`);

  for (const item of r.items) {
    lines.push(`${item.relativePath}:${item.line} ${item.kind} ${item.name} — ${item.content}`);
  }

  if (r.truncated) {
    lines.push(`... ${r.total - r.items.length} more`);
  }

  return lines.join("\n");
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
