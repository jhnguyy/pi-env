/**
 * @module _shared/ui-render
 * @purpose Centralized TUI slot manager for pi-env extensions.
 *
 * Extensions call setSlot() / clearSlot() instead of directly calling
 * ctx.ui.setWidget() / ctx.ui.setStatus(). The manager owns:
 *   - Slot definitions (key → order + placement)
 *   - Ordering: belowEditor slots re-render in ascending `order` on every
 *     setSlot() call, ensuring consistent top-to-bottom layout regardless of
 *     which extension calls first.
 *   - isHeadless guard — all calls are no-ops in headless contexts.
 *
 * WHY globalThis:
 *   jiti loads extensions with moduleCache: false, so each extension file
 *   gets its own evaluation of every imported module — including this one.
 *   globalThis is the only scope that truly survives across evaluations.
 *
 * ADDING A SLOT:
 *   1. Add an entry to SLOTS below.
 *   2. Have the owning extension call setSlot(key, content, ctx) when its
 *      data is ready and clearSlot(key, ctx) when it has nothing to show.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isHeadless } from "./context.js";

// ─── Slot registry ────────────────────────────────────────────────────────────

export type SlotPlacement = "belowEditor" | "status";

interface SlotDef {
  readonly order: number;       // belowEditor: lower = closer to top
  readonly placement: SlotPlacement;
}

/**
 * Registered UI slots. order controls top-to-bottom render position for
 * belowEditor slots. status slots are independent (rendered in the footer).
 */
export const SLOTS = {
  "session-todos": { order: 1,  placement: "belowEditor" },
  "work-tracker":  { order: 2,  placement: "belowEditor" },
  "usage-bar":     { order: 10, placement: "status"      },
} as const satisfies Record<string, SlotDef>;

export type SlotKey = keyof typeof SLOTS;

// ─── Shared state ─────────────────────────────────────────────────────────────

const STATE_KEY = "__piEnv_uiRender_v1";

interface SlotState {
  content: Map<SlotKey, string[] | undefined>;
}

function getState(): SlotState {
  const g = globalThis as Record<string, unknown>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { content: new Map<SlotKey, string[] | undefined>() };
  return g[STATE_KEY] as SlotState;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Set a slot's content and trigger a render pass. No-op in headless contexts.
 *
 * For belowEditor slots: all belowEditor slots are re-rendered in order so
 * the Map insertion order in pi's widget container stays consistent.
 * For status slots: calls ctx.ui.setStatus directly.
 */
export function setSlot(
  key: SlotKey,
  content: string[] | string | undefined,
  ctx: ExtensionContext,
): void {
  if (isHeadless(ctx)) return;
  const lines = typeof content === "string" ? [content] : content;
  getState().content.set(key, lines);
  flush(ctx);
}

/**
 * Clear a slot's content and trigger a render pass. No-op in headless contexts.
 */
export function clearSlot(key: SlotKey, ctx: ExtensionContext): void {
  if (isHeadless(ctx)) return;
  getState().content.delete(key);
  flush(ctx);
}

/**
 * Re-render all slots from current state. Call after session_start or when
 * multiple slots need updating without triggering intermediate renders.
 */
export function flush(ctx: ExtensionContext): void {
  if (isHeadless(ctx)) return;
  const { content } = getState();

  // belowEditor: always render in ascending order so Map insertion order
  // in pi's widget container matches desired top-to-bottom layout.
  const belowEditor = (Object.entries(SLOTS) as [SlotKey, SlotDef][])
    .filter(([, d]) => d.placement === "belowEditor")
    .sort((a, b) => a[1].order - b[1].order);

  for (const [key, def] of belowEditor) {
    ctx.ui.setWidget(key, content.get(key), { placement: def.placement as "belowEditor" });
  }

  // status: independent per key, no ordering concern
  for (const [key, def] of Object.entries(SLOTS) as [SlotKey, SlotDef][]) {
    if (def.placement !== "status") continue;
    ctx.ui.setStatus(key, content.get(key)?.[0]);
  }
}

/**
 * Clear all slot state (in-memory only — no ctx needed).
 * Call from session_shutdown so stale content doesn't persist across reloads.
 */
export function resetSlots(): void {
  getState().content.clear();
}
