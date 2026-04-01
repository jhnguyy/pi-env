/**
 * Utility functions — position conversion, path normalization, text extraction.
 */

import { relative, resolve } from "node:path";

// ─── Position Conversion ─────────────────────────────────────────────────────

/** Convert 1-indexed (line, character) to 0-indexed LSP position. */
export function toZeroBased(line: number, character: number): { line: number; character: number } {
  return { line: line - 1, character: character - 1 };
}

/** Convert 0-indexed LSP position to 1-indexed (line, character). */
export function toOneBased(line: number, character: number): { line: number; character: number } {
  return { line: line + 1, character: character + 1 };
}

// ─── Path Utilities ───────────────────────────────────────────────────────────

/** Convert a file path to a URI. */
export function pathToUri(path: string): string {
  return "file://" + resolve(path);
}

/** Convert a URI to a file path. */
export function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

/**
 * Get the relative path from a project root to a file.
 * Falls back to the absolute path if the file is not under the root.
 */
export function relativePath(projectRoot: string, filePath: string): string {
  const rel = relative(projectRoot, filePath);
  // If relative path goes outside project root, use basename
  if (rel.startsWith("..")) return filePath;
  return rel;
}


// ─── LSP Symbol Kind → Label ─────────────────────────────────────────────────

/** Map LSP SymbolKind numeric codes to human-readable labels. */
export function symbolKindLabel(kind: number): string {
  const kinds: Record<number, string> = {
    1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
    6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
    11: "interface", 12: "function", 13: "variable", 14: "constant",
    15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
    20: "key", 21: "null", 22: "enum member", 23: "struct", 24: "event",
    25: "operator", 26: "type parameter",
  };
  return kinds[kind] ?? "symbol";
}

// ─── LSP Diagnostic Severity → Label ─────────────────────────────────────────

export function severityLabel(severity: number): "error" | "warning" | "info" | "hint" {
  switch (severity) {
    case 1: return "error";
    case 2: return "warning";
    case 3: return "info";
    case 4: return "hint";
    default: return "error";
  }
}

// ─── Message Truncation ───────────────────────────────────────────────────────

/** Truncate a diagnostic message to its first sentence. */
export function truncateMessage(msg: string): string {
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
