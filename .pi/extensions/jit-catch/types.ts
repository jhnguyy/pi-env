/**
 * Shared types for the jit-catch extension.
 */

/** How to acquire the diff. */
export type DiffSource = "unstaged" | "staged" | "commit";

/** One extension's worth of changed files, extracted from a diff. */
export interface ExtensionDiff {
  name: string;
  /** All non-test source file paths that changed within this extension. */
  changedFiles: string[];
}

/** Result of parsing a unified diff. */
export interface ParseResult {
  extensions: ExtensionDiff[];
  /** True if the diff also touched files outside any extensions/ directory. */
  hasNonExtensionFiles: boolean;
}

/** Result of running catching tests for a single extension. */
export interface ExtensionRunResult {
  extName: string;
  passed: boolean;
  /** Combined stdout+stderr from bun test. */
  testOutput: string;
  /** Absolute path to the test file, or null if it was auto-discarded on pass. */
  testPath: string | null;
}
