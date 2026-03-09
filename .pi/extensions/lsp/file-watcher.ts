/**
 * File watcher — monitors TypeScript project directories for changes.
 *
 * Uses fs.watch({ recursive: true }) with 100ms debounce per file.
 * Ignores: node_modules, .git, dist, build, .next, out, .cache
 */

import { watch, type FSWatcher } from "node:fs";
import { extname, basename, resolve, relative } from "node:path";
import { TS_EXTENSIONS } from "./filetypes";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChangeCallback = (absolutePath: string) => void;

const WATCHED_EXTENSIONS = TS_EXTENSIONS;

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", ".cache", ".turbo", "coverage",
]);

// ─── FileWatcher ─────────────────────────────────────────────────────────────

export class FileWatcher {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private onChange: ChangeCallback;
  private debounceMs: number;

  constructor(onChange: ChangeCallback, debounceMs = 100) {
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  /** Start watching a project root directory. Idempotent. */
  watch(projectRoot: string): void {
    const absRoot = resolve(projectRoot);
    if (this.watchers.has(absRoot)) return;

    try {
      const watcher = watch(absRoot, { recursive: true }, (event, filename) => {
        if (!filename) return;
        this.handleChange(absRoot, filename);
      });

      watcher.on("error", () => {
        // Silently ignore watcher errors (e.g., directory deleted)
        this.unwatch(absRoot);
      });

      this.watchers.set(absRoot, watcher);
    } catch {
      // fs.watch may fail on some systems — non-fatal
    }
  }

  /** Stop watching a project root directory. */
  unwatch(projectRoot: string): void {
    const absRoot = resolve(projectRoot);
    const watcher = this.watchers.get(absRoot);
    if (watcher) {
      watcher.close();
      this.watchers.delete(absRoot);
    }
  }

  /** Stop all watchers. */
  close(): void {
    for (const [root] of this.watchers) this.unwatch(root);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
  }

  /** Returns the set of currently watched roots. */
  get roots(): Set<string> {
    return new Set(this.watchers.keys());
  }

  /** Returns the count of pending debounce timers (for testing). */
  get pendingTimers(): number {
    return this.debounceTimers.size;
  }

  private handleChange(projectRoot: string, filename: string): void {
    // Build absolute path
    const absPath = resolve(projectRoot, filename);

    // Check extension
    const ext = extname(absPath);
    if (!WATCHED_EXTENSIONS.has(ext)) return;

    // Check ignored directories (look at each path segment)
    const rel = relative(projectRoot, absPath);
    const segments = rel.split(/[\\/]/);
    for (const seg of segments.slice(0, -1)) {
      if (IGNORED_DIRS.has(seg)) return;
    }

    // Check if the file name itself starts with a dot
    const name = basename(absPath);
    if (name.startsWith(".")) return;

    // Debounce
    const existing = this.debounceTimers.get(absPath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(absPath);
      this.onChange(absPath);
    }, this.debounceMs);

    this.debounceTimers.set(absPath, timer);
  }
}
