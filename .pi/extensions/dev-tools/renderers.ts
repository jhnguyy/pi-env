/**
 * Renderers — human TUI rendering for LSP results.
 *
 * Transforms structured `details` into themed Text components for pi TUI.
 * LLM never sees this — it's purely for human display.
 *
 * Individual action renderers are registered in register-actions.ts.
 * This file provides the top-level renderDevToolsResult + renderDevToolsCall.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { toolResultText, type ToolResultRenderContext } from "../_shared/tool-render";
import { Text } from "@earendil-works/pi-tui";
import type { LspResult } from "./protocol";
import { getAction } from "./action-registry";
import type { RenderTheme } from "./render-contracts";
export type { RenderTheme } from "./render-contracts";

// ─── Main renderResult ────────────────────────────────────────────────────────

/**
 * Render an LSP tool result for human TUI display.
 * Dispatches to per-action renderers via the action registry.
 */
export function renderDevToolsResult(
  result: AgentToolResult<LspResult | null>,
  opts: Pick<ToolRenderResultOptions, "expanded">,
  theme: RenderTheme,
  context: ToolResultRenderContext,
): Text {
  if (context.isError) {
    const msg = toolResultText(result) || "error";
    return new Text(theme.fg("error", `✗ ${msg}`), 0, 0);
  }

  const details = result.details;
  if (!details) {
    return new Text(theme.fg("muted", toolResultText(result)), 0, 0);
  }

  const entry = getAction(details.action);
  if (entry) return entry.renderer(details, opts, theme, context);

  // Fallback for unknown action types
  return new Text(toolResultText(result), 0, 0);
}

// ─── renderCall ───────────────────────────────────────────────────────────────

/**
 * Render a dev-tools tool call for human TUI display.
 */
export function renderDevToolsCall(
  args: {
    action: string;
    path?: string | string[];
    line?: number;
    character?: number;
    query?: string;
    newName?: string;
  },
  theme: RenderTheme,
): Text {
  let text = theme.fg("toolTitle", theme.bold("dev-tools"));
  text += " " + theme.fg("accent", args.action);

  if (args.path) {
    const pathStr = Array.isArray(args.path)
      ? args.path.length === 1
        ? args.path[0]
        : `[${args.path.length} files]`
      : args.path;
    const short =
      Array.isArray(args.path) && args.path.length !== 1
        ? pathStr
        : pathStr.split("/").slice(-2).join("/");
    text += " " + theme.fg("muted", short);
  }

  if (args.line != null) {
    text += theme.fg("muted", `:${args.line}`);
    if (args.character != null) text += theme.fg("muted", `:${args.character}`);
  }

  if (args.query) {
    text += " " + theme.fg("muted", `"${args.query}"`);
  }
  if (args.newName) {
    text += " " + theme.fg("muted", `→ ${args.newName}`);
  }

  return new Text(text, 0, 0);
}
