/**
 * id.ts — shared random ID generation.
 *
 * Wraps `randomBytes(n).toString("hex")` into a named helper so callers
 * don't need to import `node:crypto` themselves.
 *
 * Consumers: agent-bus/bus-client, agent-bus/transport, orch/manager,
 *            tmux/tmux-service, tmux/pane-manager.
 */

import { randomBytes } from "node:crypto";

/**
 * Generate a random hex string of the given byte length.
 * Default: 3 bytes → 6-char hex string (e.g. "a3f1c2").
 */
export function generateId(bytes: number = 3): string {
  return randomBytes(bytes).toString("hex");
}
