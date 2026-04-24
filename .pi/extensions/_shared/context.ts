/**
 * context.ts — shared session-context helpers for pi-env extensions.
 *
 * @purpose Provides an "am I headless?" check for rendering guards.
 *
 *   isHeadless(ctx) — "should I render UI widgets / status bar entries?"
 *     True when ctx.hasUI is false (RPC mode, print mode, in-process
 *     agentLoop subagents). Safe for all rendering guards.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

/**
 * Returns true when the current process has no interactive TUI.
 * Use this to gate widget / status bar rendering.
 */
export function isHeadless(ctx: ExtensionContext): boolean {
  return !ctx.hasUI;
}
