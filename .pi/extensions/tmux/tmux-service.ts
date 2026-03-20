/**
 * tmux-service — module-level PaneManager + TmuxClient singleton.
 *
 * Single source of truth for the TmuxClient + PaneManager pair.
 * Both tmux/index.ts and orch/manager.ts import from here so all
 * pane operations share one manager instance and one session prefix
 * regardless of which extension initiates the service.
 *
 * @stable — This is a cross-extension API. The exported function signatures
 * (initTmuxService, getTmuxService) and the TmuxService shape must not change
 * without updating orch/manager.ts.
 *
 * Known consumers (direct import via ../tmux/tmux-service):
 *   - tmux/index.ts   — calls initTmuxService(pi.exec) at extension load
 *   - orch/manager.ts — calls getTmuxService() to share the same PaneManager
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

let _instance: TmuxService | null = null;

/**
 * Initialize (or return existing) tmux service.
 * Must be called with execFn on first use (typically by tmux/index.ts at load time).
 * Subsequent calls return the cached instance regardless of arguments.
 */
export function initTmuxService(execFn: ExecFn): TmuxService {
  if (_instance) return _instance;
  const client = new TmuxClient(execFn);
  const config: TmuxConfig = {
    ...DEFAULT_CONFIG,
    sessionPrefix: generateId(2),
  };
  const manager = new PaneManager(client, config);
  _instance = { manager, client };
  return _instance;
}

/**
 * Return the existing tmux service.
 * Throws if not yet initialized — orch calls this after tmux extension has
 * already initialized the singleton.
 */
export function getTmuxService(): TmuxService {
  if (!_instance) {
    throw new Error(
      "TmuxService not initialized — tmux extension must load before orch",
    );
  }
  return _instance;
}

/**
 * Reset the singleton for testing. NOT for production use.
 * Allows tests to re-initialize with a different ExecFn.
 */
export function _resetTmuxServiceForTesting(): void {
  _instance = null;
}
