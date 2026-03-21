/**
 * @module _shared/id
 * @purpose Random hex ID generation. Use for pane IDs, bus sessions, request IDs.
 *
 * @example
 *   const id = generateId();    // "a3f1c2" (6-char hex, 3 bytes)
 *   const id = generateId(8);   // 16-char hex
 */

import { randomBytes } from "node:crypto";

/**
 * Generate a random hex string of the given byte length.
 * Default: 3 bytes → 6-char hex string (e.g. "a3f1c2").
 */
export function generateId(bytes: number = 3): string {
  return randomBytes(bytes).toString("hex");
}
