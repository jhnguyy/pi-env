/**
 * FileCache — async file reading with size guards and LRU caching.
 *
 * Replaces synchronous readFileSync calls in handlers that block the daemon
 * event loop. Caches recently-read files to avoid redundant I/O when
 * the same file is referenced across multiple handler results (e.g.,
 * 20 references across 5 files reads each file once, not 20 times).
 *
 * Size guard: files > MAX_FILE_SIZE_BYTES are not read — handlers receive
 * null and must degrade gracefully (similar to read tool's truncation).
 */

import { readFile, stat } from "node:fs/promises";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum file size to read. Larger files return null. */
export const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB

/** Maximum number of cached files. LRU eviction above this. */
const MAX_CACHE_ENTRIES = 64;

// ─── FileCache ────────────────────────────────────────────────────────────────

interface CacheEntry {
  content: string;
  lines: string[];
  accessOrder: number;
}

export class FileCache {
  private cache = new Map<string, CacheEntry>();
  private accessCounter = 0;

  /**
   * Read a file asynchronously with size guard.
   * Returns null if the file doesn't exist, exceeds MAX_FILE_SIZE_BYTES, or can't be read.
   */
  async readFile(path: string): Promise<string | null> {
    const cached = this.cache.get(path);
    if (cached) {
      cached.accessOrder = ++this.accessCounter;
      return cached.content;
    }

    try {
      const st = await stat(path);
      if (st.size > MAX_FILE_SIZE_BYTES) return null;

      const content = await readFile(path, "utf8");
      const lines = content.split("\n");
      this.cache.set(path, { content, lines, accessOrder: ++this.accessCounter });
      this.evict();
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Get a single line from a file (1-indexed). Returns empty string on any failure.
   * Uses cache if available, otherwise reads the file.
   */
  async getLine(path: string, lineNumber: number): Promise<string> {
    const content = await this.readFile(path);
    if (!content) return "";
    const entry = this.cache.get(path);
    if (!entry) return "";
    return (entry.lines[lineNumber - 1] ?? "").trim();
  }

  /**
   * Extract lines from a file (0-indexed start, 0-indexed inclusive end).
   * Returns null if the file can't be read.
   */
  async extractLines(path: string, startLine: number, endLine: number): Promise<string | null> {
    const content = await this.readFile(path);
    if (!content) return null;
    const entry = this.cache.get(path);
    if (!entry) return null;
    return entry.lines.slice(startLine, endLine + 1).join("\n");
  }

  /**
   * Expand a range to include the full declaration block.
   * Starting from startLine (0-indexed), finds a reasonable end by looking for
   * matching braces. Returns the final 0-indexed end line.
   */
  async expandToBlock(path: string, startLine: number, givenEndLine: number, maxLines = 30): Promise<number> {
    const content = await this.readFile(path);
    if (!content) return givenEndLine;
    const entry = this.cache.get(path);
    if (!entry) return givenEndLine;
    const lines = entry.lines;

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
  }

  /** Invalidate a specific path (call after file changes). */
  invalidate(path: string): void {
    this.cache.delete(path);
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }

  private evict(): void {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return;
    const sorted = [...this.cache.entries()]
      .sort((a, b) => a[1].accessOrder - b[1].accessOrder);
    const toRemove = sorted.slice(0, this.cache.size - MAX_CACHE_ENTRIES);
    for (const [key] of toRemove) this.cache.delete(key);
  }
}
