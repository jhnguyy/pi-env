/**
 * Action registry — centralizes handler, formatter, and renderer dispatch.
 *
 * Adding a new LSP action requires:
 * 1. Add the action to LspAction in protocol.ts
 * 2. Add a result type to protocol.ts
 * 3. Implement the handler in handlers.ts
 * 4. Register handler + formatter + renderer here
 *
 * No more switch statements in formatters.ts, renderers.ts, or daemon.ts dispatch.
 */

import type { LspResult, LspAction } from "./protocol";
import type { DaemonRequest, DaemonResponse } from "./protocol";
import type { HandlerDeps } from "./handlers";
import type { RenderTheme } from "./renderers";
import { Text } from "@mariozechner/pi-tui";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActionHandler = (req: DaemonRequest, deps: HandlerDeps) => Promise<DaemonResponse> | DaemonResponse;
export type ResultFormatter = (result: any) => string;
export type ResultRenderer = (result: any, opts: { expanded?: boolean }, theme: RenderTheme) => Text;

interface ActionEntry {
  handler: ActionHandler;
  formatter: ResultFormatter;
  renderer: ResultRenderer;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<LspAction, ActionEntry>();

export function registerAction(
  action: LspAction,
  entry: ActionEntry,
): void {
  registry.set(action, entry);
}

/** Look up all three dispatch functions for an action in one call. */
export function getAction(action: LspAction): ActionEntry | undefined {
  return registry.get(action);
}

/** Format any LspResult by dispatching to the registered formatter. */
export function formatResult(result: LspResult): string {
  const entry = registry.get(result.action as LspAction);
  if (!entry) return JSON.stringify(result);
  return entry.formatter(result);
}

/** Get all registered action names (for building tool parameter enums). */
export function getRegisteredActions(): LspAction[] {
  return [...registry.keys()];
}
