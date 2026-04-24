/**
 * tmux-service — module-level PaneManager + TmuxClient singleton.
 *
 * Single source of truth for the TmuxClient + PaneManager pair.
 * Both tmux/index.ts imports from here so all
 * pane operations share one manager instance and one session prefix
 * regardless of which extension initiates the service.
 *
 * @stable — This is a cross-extension API. The exported function signatures
 * (initTmuxService, getTmuxService) and the TmuxService shape must not change
 * without updating other consumers.
 *
 * Known consumers (direct import via ../tmux/tmux-service):
 *   - tmux/index.ts   — calls initTmuxService(pi.exec) at extension load
 *   - (no other known consumers)
 *
 * Why not _shared/? tmux-service depends on TmuxClient + PaneManager which
 * are tmux internals. Keeping it here avoids a circular topology.
 */

import { generateId } from "../_shared/id";
import { TmuxClient } from "./tmux-client";
import { PaneManager } from "./pane-manager";
import type { TmuxConfig, ExecFn } from "./types";
import { DEFAULT_CONFIG } from "./types";

// ─── Singleton ───────────────────────────────────────────────

interface TmuxService {
  manager: PaneManager;
  client: TmuxClient;
}

/**
 * globalThis key for the TmuxService singleton.
 *
 * Using globalThis instead of a module-level variable ensures that when
 * this file is bundled into the tmux extension bundle (
 * each bundle it inline), all copies share the same live instance.
 * Module-level variables are per-bundle; globalThis is process-wide.
 */
const TMUX_SERVICE_KEY = "__pi_tmux_service__";

/**
 * Initialize (or return existing) tmux service.
 * Must be called with execFn on first use (typically by tmux/index.ts at load time).
 * Subsequent calls return the cached instance regardless of arguments.
 */
export function initTmuxService(execFn: ExecFn): TmuxService {
  const existing = (globalThis as Record<string, unknown>)[TMUX_SERVICE_KEY] as TmuxService | undefined;
  if (existing) return existing;
  const client = new TmuxClient(execFn);
  const config: TmuxConfig = {
    ...DEFAULT_CONFIG,
    sessionPrefix: generateId(2),
  };
  const manager = new PaneManager(client, config);
  const instance: TmuxService = { manager, client };
  (globalThis as Record<string, unknown>)[TMUX_SERVICE_KEY] = instance;
  return instance;
}

/**
 * Return the existing tmux service.
 * Throws if not yet initialized — call this after tmux extension has loaded.
 * already initialized the singleton.
 */
export function getTmuxService(): TmuxService {
  const instance = (globalThis as Record<string, unknown>)[TMUX_SERVICE_KEY] as TmuxService | undefined;
  if (!instance) {
    throw new Error(
      "TmuxService not initialized — tmux extension must load first",
    );
  }
  return instance;
}

/**
 * Reset the singleton for testing. NOT for production use.
 * Allows tests to re-initialize with a different ExecFn.
 */
export function _resetTmuxServiceForTesting(): void {
  (globalThis as Record<string, unknown>)[TMUX_SERVICE_KEY] = null;
}
