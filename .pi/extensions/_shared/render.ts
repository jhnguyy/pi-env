/**
 * render.ts — shared TUI rendering helpers.
 *
 * Provides the standard error/success renderResult pattern used by
 * agent-bus, tmux, orch, and jit-catch. All four were duplicating the
 * same 10-line block verbatim.
 *
 * Consumers: agent-bus/index.ts, tmux/index.ts, orch/index.ts, jit-catch/index.ts.
 */

import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

// ─── defaultRenderResult ─────────────────────────────────────────────────────

/**
 * Standard renderResult implementation:
 *   - Reads first text content block.
 *   - If `result.details` has an `error` key → renders in error color.
 *   - Otherwise → renders in success color, prefixed with "✓ ".
 *
 * @param opts.truncateToFirstLine  Trim success text to its first line (orch uses this).
 */
export function defaultRenderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  theme: Theme,
  opts?: { truncateToFirstLine?: boolean },
): Text {
  const first = result.content[0];
  const raw = first?.type === "text" ? (first.text ?? "") : "";
  const text = opts?.truncateToFirstLine ? raw.split("\n")[0] : raw;

  const isError =
    result.details != null &&
    typeof result.details === "object" &&
    "error" in result.details;

  if (isError) {
    return new Text(theme.fg("error", text || "error"), 0, 0);
  }
  return new Text(theme.fg("success", "✓ " + text), 0, 0);
}
