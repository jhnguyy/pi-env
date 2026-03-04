/**
 * Utility functions — position conversion, path normalization, text extraction.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

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
 * Find the project root for a given file path.
 * Walks up the directory tree looking for tsconfig.json or jsconfig.json.
 * Returns null if none found.
 */
export function findProjectRoot(filePath: string): string | null {
  let dir = existsSync(filePath) && !filePath.endsWith(".ts") && !filePath.endsWith(".tsx")
    ? filePath
    : dirname(filePath);

  while (true) {
    if (
      existsSync(resolve(dir, "tsconfig.json")) ||
      existsSync(resolve(dir, "jsconfig.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
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

// ─── Text Extraction ─────────────────────────────────────────────────────────

/**
 * Extract lines from a file given a 0-indexed start line and end line (inclusive).
 * Returns null if file cannot be read.
 */
export function extractLines(
  filePath: string,
  startLine: number, // 0-indexed
  endLine: number,   // 0-indexed, inclusive
): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    return lines.slice(startLine, endLine + 1).join("\n");
  } catch {
    return null;
  }
}

/**
 * Get a single trimmed line from a file. Returns empty string on error.
 * lineNumber is 1-indexed.
 */
export function getFileLine(filePath: string, lineNumber: number): string {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    return (lines[lineNumber - 1] ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * Expand a range to include the full declaration block.
 * Starting from startLine (0-indexed), finds a reasonable end by looking for
 * matching braces or end of block. Returns the final 0-indexed end line.
 */
export function expandToBlock(
  filePath: string,
  startLine: number, // 0-indexed
  givenEndLine: number, // 0-indexed, from LSP
  maxLines: number = 30,
): number {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    // If already multi-line and the LSP gave us a meaningful range, trust it
    if (givenEndLine > startLine) return Math.min(givenEndLine, startLine + maxLines - 1);

    // Single-line: look for opening brace and match it
    let depth = 0;
    let foundOpen = false;
    for (let i = startLine; i < lines.length && i < startLine + maxLines; i++) {
      for (const ch of lines[i]!) {
        if (ch === "{") { depth++; foundOpen = true; }
        if (ch === "}") { depth--; }
      }
      if (foundOpen && depth === 0) return i;
    }

    return Math.min(startLine + maxLines - 1, lines.length - 1);
  } catch {
    return givenEndLine;
  }
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
