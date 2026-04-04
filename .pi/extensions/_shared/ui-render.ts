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

export type SlotPlacement = "aboveEditor" | "belowEditor" | "status";

interface SlotDef {
  readonly order: number;  // lower = closer to top within each placement group
  readonly placement: SlotPlacement;
}

/**
 * Registered UI slots.
 *
 *   aboveEditor — above the input editor, below chat messages (persistent context)
 *   belowEditor — below the input editor, above the footer (transient status)
 *   status      — inside the footer; all status slots join on one line (avoid >1)
 *
 * Layout:
 *   [session-todos]   aboveEditor  — todo list visible above where you type
 *   ── input editor ──
 *   [work-tracker]    belowEditor  — git branch/dirty state
 *   [usage-bar]       belowEditor  — API quota, below work-tracker
 *   ── footer: token stats · model ──
 */
export const SLOTS = {
  "session-todos": { order: 1, placement: "aboveEditor" },
  "work-tracker":  { order: 1, placement: "belowEditor" },
  "usage-bar":     { order: 2, placement: "belowEditor" },
} as const satisfies Record<string, SlotDef>;

export type SlotKey = keyof typeof SLOTS;

// ─── Shared state ─────────────────────────────────────────────────────────────

const STATE_KEY = "__piEnv_uiRender_v1";

interface SlotState {
  content: Map<SlotKey, string[] | undefined>;
  batching: boolean;
}

function getState(): SlotState {
  const g = globalThis as Record<string, unknown>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { content: new Map<SlotKey, string[] | undefined>(), batching: false };
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
  const state = getState();
  const lines = typeof content === "string" ? [content] : content;
  state.content.set(key, lines);
  if (!state.batching) flush(ctx);
}

/**
 * Clear a slot's content and trigger a render pass. No-op in headless contexts.
 */
export function clearSlot(key: SlotKey, ctx: ExtensionContext): void {
  if (isHeadless(ctx)) return;
  const state = getState();
  state.content.delete(key);
  if (!state.batching) flush(ctx);
}

/**
 * Batch multiple slot updates into a single flush pass.
 *
 * All setSlot/clearSlot calls inside `fn` update the slot map without
 * triggering intermediate flushes. One flush fires after `fn` returns,
 * rendering all changes in a single pass.
 *
 * @example
 *   batchSlots(() => {
 *     setSlot("session-todos", ..., ctx);
 *     setSlot("work-tracker", ..., ctx);
 *   }, ctx);
 */
export function batchSlots(fn: () => void, ctx: ExtensionContext): void {
  if (isHeadless(ctx)) return;
  const state = getState();
  state.batching = true;
  try {
    fn();
  } finally {
    state.batching = false;
    flush(ctx);
  }
}

/**
 * Re-render all slots from current state. Call after session_start or when
 * multiple slots need updating without triggering intermediate renders.
 */
export function flush(ctx: ExtensionContext): void {
  if (isHeadless(ctx)) return;
  const { content } = getState();

  // aboveEditor + belowEditor: render each group in ascending order.
  // setWidget always removes + re-inserts, so calling in order means
  // Map insertion order = top-to-bottom render order within each group.
  for (const placement of ["aboveEditor", "belowEditor"] as const) {
    const group = (Object.entries(SLOTS) as [SlotKey, SlotDef][])
      .filter(([, d]) => d.placement === placement)
      .sort((a, b) => a[1].order - b[1].order);
    for (const [key] of group) {
      ctx.ui.setWidget(key, content.get(key), { placement });
    }
  }

  // status: all keys join on one line — only use for a single slot
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
