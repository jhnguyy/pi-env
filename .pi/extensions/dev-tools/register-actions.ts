/**
 * register-actions.ts — populates the action registry with all handlers, formatters, and renderers.
 *
 * Import this file for side effects to wire up dispatch. Adding a new action:
 * 1. Add type to protocol.ts
 * 2. Add handler to handlers.ts
 * 3. Add formatter to formatters.ts
 * 4. Add renderer to renderers.ts
 * 5. Add registerAction() call here
 */

import { registerAction } from "./action-registry";
import {
  handleDiagnostics, handleHover, handleDefinition, handleImplementation,
  handleReferences, handleIncomingCalls, handleOutgoingCalls,
  handleSymbols, handleStatus,
} from "./handlers";
import {
  formatDiagnostics, formatHover, formatDefinition, formatImplementation,
  formatReferences, formatIncomingCalls, formatOutgoingCalls,
  formatSymbols, formatStatus,
} from "./formatters";
import { Text } from "@mariozechner/pi-tui";
import type { RenderTheme } from "./renderers";
import type {
  DiagnosticsResult, IncomingCallsResult, OutgoingCallsResult, SymbolsResult, StatusResult,
} from "./protocol";

// ─── Shared renderer helpers ──────────────────────────────────────────────────

function renderDiagnostics(d: DiagnosticsResult, opts: { expanded?: boolean }, theme: RenderTheme): Text {
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

function renderCallHierarchy(d: IncomingCallsResult | OutgoingCallsResult, _opts: { expanded?: boolean }, theme: RenderTheme): Text {
  const direction = d.action === "incoming-calls" ? "caller" : "callee";
  const text = d.total === 0
    ? theme.fg("muted", `— no ${direction}s`)
    : theme.fg("success", `✓ ${d.total} ${direction}${d.total !== 1 ? "s" : ""}`) +
      ` ${theme.fg("muted", `of ${d.symbol}`)}`;
  return new Text(text, 0, 0);
}

function renderSymbols(d: SymbolsResult, _opts: { expanded?: boolean }, theme: RenderTheme): Text {
  const label = d.query ? `"${d.query}"` : d.path?.split("/").pop() ?? "";
  const text = theme.fg("success", `✓ ${d.total} symbol${d.total !== 1 ? "s" : ""}`) +
    (label ? ` ${theme.fg("muted", label)}` : "");
  return new Text(text, 0, 0);
}

function renderStatus(d: StatusResult, _opts: { expanded?: boolean }, theme: RenderTheme): Text {
  const text = d.running
    ? theme.fg("success", "✓ daemon running") + theme.fg("muted", ` PID:${d.pid ?? "?"}`)
    : theme.fg("muted", "— daemon stopped");
  return new Text(text, 0, 0);
}

// ─── Simple one-liner renderers ───────────────────────────────────────────────

const successRenderer = (label: string) =>
  (r: any, _opts: { expanded?: boolean }, theme: RenderTheme) =>
    new Text(theme.fg("success", `✓ ${label}`), 0, 0);

// ─── Register all actions ─────────────────────────────────────────────────────

registerAction("diagnostics", {
  handler: handleDiagnostics,
  formatter: formatDiagnostics,
  renderer: renderDiagnostics,
});

registerAction("hover", {
  handler: handleHover,
  formatter: formatHover,
  renderer: (_r, _opts, theme) => new Text(theme.fg("success", "✓ hover"), 0, 0),
});

registerAction("definition", {
  handler: handleDefinition,
  formatter: formatDefinition,
  renderer: (r, _opts, theme) => new Text(theme.fg("success", `✓ ${r.locations.length} location(s)`), 0, 0),
});

registerAction("implementation", {
  handler: handleImplementation,
  formatter: formatImplementation,
  renderer: (r, _opts, theme) => new Text(theme.fg("success", `✓ ${r.locations.length} implementation(s)`), 0, 0),
});

registerAction("references", {
  handler: handleReferences,
  formatter: formatReferences,
  renderer: (r, _opts, theme) => new Text(theme.fg("success", `✓ ${r.total} reference(s)`), 0, 0),
});

registerAction("incoming-calls", {
  handler: handleIncomingCalls,
  formatter: formatIncomingCalls,
  renderer: renderCallHierarchy,
});

registerAction("outgoing-calls", {
  handler: handleOutgoingCalls,
  formatter: formatOutgoingCalls,
  renderer: renderCallHierarchy,
});

registerAction("symbols", {
  handler: handleSymbols,
  formatter: formatSymbols,
  renderer: renderSymbols,
});

registerAction("status", {
  handler: handleStatus,
  formatter: formatStatus,
  renderer: renderStatus,
});
