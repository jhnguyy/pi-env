/**
 * Filetype predicates — client-side gates for the dev-tools extension.
 *
 * These are used by index.ts (client process) which can't reach the daemon's
 * backend registry. The supported extensions are derived from backend-configs.ts
 * so there's a single source of truth.
 */
import { extname } from "node:path";
import { ALL_SUPPORTED_EXTENSIONS } from "./backend-configs";

/** True if any backend can handle this file (LSP diagnostics available). */
export function isLspSupported(path: string): boolean {
  return ALL_SUPPORTED_EXTENSIONS.has(extname(path));
}
