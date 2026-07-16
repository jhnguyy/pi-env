import { readFile, stat } from "node:fs/promises";
import { Cache, Data, Duration, Effect, Exit } from "effect";

/** Maximum file size to read. Larger files return null. */
export const MAX_FILE_SIZE_BYTES = 512 * 1024;

/** Maximum number of cached files. Least-recently-used entries are evicted above this limit. */
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  readonly content: string;
  readonly lines: readonly string[];
}

class FileCacheReadError extends Data.TaggedError("FileCacheReadError")<{
  readonly cause: unknown;
}> {}

const loadEntry = (path: string): Effect.Effect<CacheEntry, FileCacheReadError> =>
  Effect.tryPromise({
    try: async () => {
      const file = await stat(path);
      if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`File exceeds ${MAX_FILE_SIZE_BYTES} bytes`);
      }
      const content = await readFile(path, "utf8");
      return { content, lines: content.split("\n") };
    },
    catch: (cause) => new FileCacheReadError({ cause }),
  });

/**
 * Async, size-bounded file reads shared across dev-tools handlers.
 *
 * The Promise-returning surface is retained for daemon compatibility. Failed
 * lookups expire immediately so a missing, unreadable, or oversized file can
 * be retried after it changes.
 */
export class FileCache {
  private readonly cache: Cache.Cache<string, CacheEntry, FileCacheReadError>;

  constructor() {
    this.cache = Effect.runSync(
      Cache.makeWith(loadEntry, {
        capacity: MAX_CACHE_ENTRIES,
        timeToLive: (exit) => (Exit.isFailure(exit) ? Duration.zero : Duration.infinity),
      }),
    );
  }

  /**
   * Read a file asynchronously with size guard.
   * Returns null if the file doesn't exist, exceeds MAX_FILE_SIZE_BYTES, or can't be read.
   */
  async readFile(path: string): Promise<string | null> {
    const entry = await this.readEntry(path);
    return entry?.content ?? null;
  }

  /** Get a single line from a file (1-indexed). Returns empty string on any failure. */
  async getLine(path: string, lineNumber: number): Promise<string> {
    const entry = await this.readEntry(path);
    if (!entry?.content) return "";
    return (entry.lines[lineNumber - 1] ?? "").trim();
  }

  /**
   * Extract lines from a file (0-indexed start, 0-indexed inclusive end).
   * Returns null if the file can't be read.
   */
  async extractLines(path: string, startLine: number, endLine: number): Promise<string | null> {
    const entry = await this.readEntry(path);
    if (!entry?.content) return null;
    return entry.lines.slice(startLine, endLine + 1).join("\n");
  }

  /**
   * Expand a range to include the full declaration block.
   * Starting from startLine (0-indexed), finds a reasonable end by looking for
   * matching braces. Returns the final 0-indexed end line.
   */
  async expandToBlock(
    path: string,
    startLine: number,
    givenEndLine: number,
    maxLines = 30,
  ): Promise<number> {
    const entry = await this.readEntry(path);
    if (!entry?.content) return givenEndLine;
    const lines = entry.lines;

    if (givenEndLine > startLine) {
      return Math.min(givenEndLine, startLine + maxLines - 1);
    }

    let depth = 0;
    let foundOpen = false;
    for (let i = startLine; i < lines.length && i < startLine + maxLines; i++) {
      for (const character of lines[i]!) {
        if (character === "{") {
          depth++;
          foundOpen = true;
        }
        if (character === "}") depth--;
      }
      if (foundOpen && depth === 0) return i;
    }

    return Math.min(startLine + maxLines - 1, lines.length - 1);
  }

  /** Invalidate a specific path after the file changes. */
  invalidate(path: string): void {
    Effect.runSync(Cache.invalidate(this.cache, path));
  }

  /** Clear every cached file. */
  clear(): void {
    Effect.runSync(Cache.invalidateAll(this.cache));
  }

  private readEntry(path: string): Promise<CacheEntry | null> {
    return Effect.runPromise(
      Cache.get(this.cache, path).pipe(Effect.catch(() => Effect.succeed(null))),
    );
  }
}
