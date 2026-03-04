/**
 * Diff parser for jit-catch.
 *
 * Pure module — no side effects, no FS access. Accepts raw unified diff text
 * and extracts which pi extensions were modified.
 *
 * Matches `+++ b/<path>` lines where <path> contains `extensions/<name>/`.
 * Filters out __tests__ files (those are not source files to test against).
 * Handles both `b/` prefixed paths (standard git format) and bare paths.
 */

import type { ExtensionDiff, ParseResult } from "./types";

// Matches `extensions/<name>/` anywhere in a file path.
const EXT_SEGMENT = /extensions\/([^/]+)\//;

/**
 * Parse a unified diff and return which extensions have changed source files.
 *
 * @param diffText - Raw output of `git diff`, `git diff --cached`, or `git show`.
 */
export function parseDiff(diffText: string): ParseResult {
  const extMap = new Map<string, Set<string>>();
  let hasNonExtensionFiles = false;

  for (const line of diffText.split("\n")) {
    if (!line.startsWith("+++ ")) continue;

    const raw = line.slice(4); // strip "+++ "
    if (raw === "/dev/null") continue;

    // Strip git's `b/` prefix when present.
    const filePath = raw.startsWith("b/") ? raw.slice(2) : raw;

    const match = EXT_SEGMENT.exec(filePath);
    if (!match) {
      hasNonExtensionFiles = true;
      continue;
    }

    const extName = match[1];

    // Skip __tests__ files — they're not source files to generate tests for.
    if (filePath.includes("/__tests__/")) continue;

    // Skip the node_modules pseudo-extension if git picks it up somehow.
    if (extName === "node_modules") continue;

    if (!extMap.has(extName)) extMap.set(extName, new Set());
    extMap.get(extName)!.add(filePath);
  }

  const extensions: ExtensionDiff[] = Array.from(extMap.entries()).map(
    ([name, files]) => ({ name, changedFiles: Array.from(files) }),
  );

  return { extensions, hasNonExtensionFiles };
}
