/**
 * Renderers — human TUI rendering for LSP results.
 *
 * Transforms structured `details` into themed Text components for pi TUI.
 * LLM never sees this — it's purely for human display.
 *
 * Individual action renderers are registered in register-actions.ts.
 * This file provides the top-level renderDevToolsResult + renderDevToolsCall.
 */

import { Text } from "@mariozechner/pi-tui";
import type { LspResult, LspAction } from "./protocol";
import { getAction } from "./action-registry";

// ─── Theme interface (minimal, matches pi-tui theme API) ─────────────────────

export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ─── Main renderResult ────────────────────────────────────────────────────────

/**
 * Render an LSP tool result for human TUI display.
 * Dispatches to per-action renderers via the action registry.
 */
export function renderDevToolsResult(
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

  const entry = getAction(details.action as LspAction);
  if (entry) return entry.renderer(details, opts, theme);

  // Fallback for unknown action types
  return new Text(result.content[0]?.text ?? "", 0, 0);
}

// ─── renderCall ───────────────────────────────────────────────────────────────

/**
 * Render a dev-tools tool call for human TUI display.
 */
export function renderDevToolsCall(
  args: { action: string; path?: string; line?: number; character?: number; query?: string },
  theme: RenderTheme,
): Text {
  let text = theme.fg("toolTitle", theme.bold("dev-tools"));
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
