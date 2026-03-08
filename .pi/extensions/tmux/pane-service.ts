/**
 * PaneService — module-level singleton for the shared PaneManager.
 *
 * Both the tmux extension and the orch extension import from this module.
 * Node/Bun module caching guarantees a single instance across all importers
 * within a pi process — same PaneManager, same registry, same layout columns.
 *
 * Usage:
 *   tmux/index.ts   → initPaneService(exec) on session load
 *   orch/manager.ts → getPaneService() ?? initPaneService(exec) on first spawn
 *
 * First caller wins the ExecFn (initPaneService is idempotent after init).
 */

import { randomBytes } from "node:crypto";
import { PaneManager } from "./pane-manager";
import { TmuxClient } from "./tmux-client";
import type { ExecFn } from "./types";

let _instance: PaneManager | null = null;

/**
 * Initialize or return the shared PaneManager.
 * Idempotent — subsequent calls return the existing instance unchanged.
 */
export function initPaneService(exec: ExecFn): PaneManager {
  if (_instance) return _instance;
  const sessionPrefix = randomBytes(2).toString("hex");
  _instance = new PaneManager(new TmuxClient(exec), { sessionPrefix });
  return _instance;
}

/**
 * Return the shared PaneManager, or null if not yet initialized.
 */
export function getPaneService(): PaneManager | null {
  return _instance;
}

/**
 * Reset the singleton — test use only.
 * Allows each test to get a fresh PaneManager with its own mock ExecFn.
 */
export function resetPaneService(): void {
  _instance = null;
}

/**
 * Check if the current process is running inside a tmux session.
 * Convenience wrapper so callers don't need a TmuxClient instance.
 */
export function isInTmux(): boolean {
  return !!process.env.TMUX;
}
