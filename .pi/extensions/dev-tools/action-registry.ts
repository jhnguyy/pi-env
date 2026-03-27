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

export function getHandler(action: LspAction): ActionHandler | undefined {
  return registry.get(action)?.handler;
}

export function getFormatter(action: LspAction): ResultFormatter | undefined {
  return registry.get(action)?.formatter;
}

export function getRenderer(action: LspAction): ResultRenderer | undefined {
  return registry.get(action)?.renderer;
}

/** Format any LspResult by dispatching to the registered formatter. */
export function formatResult(result: LspResult): string {
  const formatter = getFormatter(result.action as LspAction);
  if (!formatter) return JSON.stringify(result);
  return formatter(result);
}

/** Get all registered action names (for building tool parameter enums). */
export function getRegisteredActions(): LspAction[] {
  return [...registry.keys()];
}
