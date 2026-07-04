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
import { Text } from "@earendil-works/pi-tui";
import { DevToolsAction } from "./action-contract";
import type { RenderTheme } from "./renderers";
import type {
  DiagnosticsResult, IncomingCallsResult, OutgoingCallsResult, SymbolsResult, StatusResult,
} from "./protocol";

// ─── Shared renderer helpers ──────────────────────────────────────────────────

function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}

function diagnosticsFileSummary(d: DiagnosticsResult): string {
  const files = d.files?.map((file) => file.path) ?? (d.path ? [d.path] : []);
  if (files.length === 0) return "";

  const visible = files.slice(0, 3).map(shortPath);
  const suffix = files.length > visible.length ? `, +${files.length - visible.length} more` : "";
  return `${files.length} file${files.length !== 1 ? "s" : ""}: ${visible.join(", ")}${suffix}`;
}

function renderDiagnostics(d: DiagnosticsResult, opts: { expanded?: boolean }, theme: RenderTheme): Text {
  if (opts.expanded) {
    return new Text(JSON.stringify(d, null, 2), 0, 0);
  }

  let text: string;
  if (d.errorCount === 0 && d.warnCount === 0) {
    text = theme.fg("success", "✓ no errors");
  } else {
    const parts: string[] = [];
    if (d.errorCount > 0) parts.push(theme.fg("error", `✗ ${d.errorCount} error${d.errorCount !== 1 ? "s" : ""}`));
    if (d.warnCount > 0) parts.push(theme.fg("warning", `⚠ ${d.warnCount} warning${d.warnCount !== 1 ? "s" : ""}`));
    text = parts.join(" ");
  }

  const fileSummary = diagnosticsFileSummary(d);
  if (fileSummary) text += ` ${theme.fg("muted", `scanned ${fileSummary}`)}`;

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

registerAction(DevToolsAction.Diagnostics, {
  handler: handleDiagnostics,
  formatter: formatDiagnostics,
  renderer: renderDiagnostics,
});

registerAction(DevToolsAction.Hover, {
  handler: handleHover,
  formatter: formatHover,
  renderer: (_r, _opts, theme) => new Text(theme.fg("success", "✓ hover"), 0, 0),
});

registerAction(DevToolsAction.Definition, {
  handler: handleDefinition,
  formatter: formatDefinition,
  renderer: (r, _opts, theme) => new Text(theme.fg("success", `✓ ${r.locations.length} location(s)`), 0, 0),
});

registerAction(DevToolsAction.Implementation, {
  handler: handleImplementation,
  formatter: formatImplementation,
  renderer: (r, _opts, theme) => new Text(theme.fg("success", `✓ ${r.locations.length} implementation(s)`), 0, 0),
});

registerAction(DevToolsAction.References, {
  handler: handleReferences,
  formatter: formatReferences,
  renderer: (r, _opts, theme) => new Text(theme.fg("success", `✓ ${r.total} reference(s)`), 0, 0),
});

registerAction(DevToolsAction.IncomingCalls, {
  handler: handleIncomingCalls,
  formatter: formatIncomingCalls,
  renderer: renderCallHierarchy,
});

registerAction(DevToolsAction.OutgoingCalls, {
  handler: handleOutgoingCalls,
  formatter: formatOutgoingCalls,
  renderer: renderCallHierarchy,
});

registerAction(DevToolsAction.Symbols, {
  handler: handleSymbols,
  formatter: formatSymbols,
  renderer: renderSymbols,
});

registerAction(DevToolsAction.Status, {
  handler: handleStatus,
  formatter: formatStatus,
  renderer: renderStatus,
});
