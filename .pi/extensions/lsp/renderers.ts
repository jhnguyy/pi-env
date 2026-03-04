/**
 * Renderers — human TUI rendering for LSP results.
 *
 * Transforms structured `details` into themed Text components for pi TUI.
 * LLM never sees this — it's purely for human display.
 */

import { Text } from "@mariozechner/pi-tui";
import type { LspResult, DiagnosticsResult, SymbolsResult, StatusResult } from "./protocol";

// ─── Theme interface (minimal, matches pi-tui theme API) ─────────────────────

export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ─── Main renderResult ────────────────────────────────────────────────────────

/**
 * Render an LSP tool result for human TUI display.
 * @param result  The tool result object (has content and details).
 * @param opts    Render options ({ expanded: boolean }).
 * @param theme   Pi TUI theme.
 */
export function renderLspResult(
  result: { isError?: boolean; content: Array<{ type: string; text?: string }>; details?: LspResult | null },
  opts: { expanded?: boolean },
  theme: RenderTheme,
): Text {
  if (result.isError) {
    const msg = result.content[0]?.text ?? "error";
    return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
  }

  const details = result.details;
  if (!details) {
    return new Text(theme.fg("muted", result.content[0]?.text ?? ""), 0, 0);
  }

  switch (details.action) {
    case "diagnostics":  return renderDiagnostics(details, opts, theme);
    case "hover":        return new Text(theme.fg("success", "✓ hover"), 0, 0);
    case "definition":   return new Text(theme.fg("success", `✓ ${details.locations.length} location(s)`), 0, 0);
    case "references":   return new Text(theme.fg("success", `✓ ${details.total} reference(s)`), 0, 0);
    case "symbols":      return renderSymbolsSummary(details, theme);
    case "status":       return renderStatusSummary(details, theme);
    default:             return new Text(result.content[0]?.text ?? "", 0, 0);
  }
}

// ─── renderCall ───────────────────────────────────────────────────────────────

/**
 * Render an lsp tool call for human TUI display.
 */
export function renderLspCall(
  args: { action: string; path?: string; line?: number; character?: number; query?: string },
  theme: RenderTheme,
): Text {
  let text = theme.fg("toolTitle", theme.bold("lsp"));
  text += " " + theme.fg("accent", args.action);

  if (args.path) {
    const short = args.path.split("/").slice(-2).join("/");
    text += " " + theme.fg("muted", short);
  }

  if (args.line != null) {
    text += theme.fg("muted", `:${args.line}`);
    if (args.character != null) text += theme.fg("muted", `:${args.character}`);
  }

  if (args.query) {
    text += " " + theme.fg("muted", `"${args.query}"`);
  }

  return new Text(text, 0, 0);
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

function renderDiagnostics(
  d: DiagnosticsResult,
  opts: { expanded?: boolean },
  theme: RenderTheme,
): Text {
  let text: string;

  if (d.errorCount === 0 && d.warnCount === 0) {
    text = theme.fg("success", "✓ no errors");
  } else {
    const parts: string[] = [];
    if (d.errorCount > 0) parts.push(theme.fg("error", `✗ ${d.errorCount} error${d.errorCount !== 1 ? "s" : ""}`));
    if (d.warnCount > 0) parts.push(theme.fg("warning", `⚠ ${d.warnCount} warning${d.warnCount !== 1 ? "s" : ""}`));
    text = parts.join(" ");
  }

  if (opts.expanded && d.items.length > 0) {
    for (const item of d.items) {
      const sev = item.severity === "error"
        ? theme.fg("error", "E")
        : item.severity === "warning"
        ? theme.fg("warning", "W")
        : theme.fg("muted", "I");
      const code = item.code ? ` ${item.code}` : "";
      text += `\n  ${sev} L${item.line}:${item.character}${code} ${item.message}`;
    }
  }

  return new Text(text, 0, 0);
}

// ─── Symbols ─────────────────────────────────────────────────────────────────

function renderSymbolsSummary(d: SymbolsResult, theme: RenderTheme): Text {
  const label = d.query ? `"${d.query}"` : d.path?.split("/").pop() ?? "";
  const text = theme.fg("success", `✓ ${d.total} symbol${d.total !== 1 ? "s" : ""}`) +
    (label ? ` ${theme.fg("muted", label)}` : "");
  return new Text(text, 0, 0);
}

// ─── Status ───────────────────────────────────────────────────────────────────

function renderStatusSummary(d: StatusResult, theme: RenderTheme): Text {
  const text = d.running
    ? theme.fg("success", "✓ daemon running") + theme.fg("muted", ` PID:${d.pid ?? "?"}`)
    : theme.fg("muted", "— daemon stopped");
  return new Text(text, 0, 0);
}
