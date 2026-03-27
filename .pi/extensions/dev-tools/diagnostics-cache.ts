/**
 * DiagnosticsCache — manages per-URI diagnostic state and waiter queues.
 *
 * Extracted from LspBackend to isolate the diagnostic publish/wait lifecycle
 * from subprocess management. One instance per LspBackend.
 */

import type { DiagnosticItem } from "./protocol";

export const DIAG_WAIT_TIMEOUT_MS = 1_500;

export class DiagnosticsCache {
  /** uri → DiagnosticItem[] */
  private cache = new Map<string, DiagnosticItem[]>();
  /** uri → resolvers waiting for first diagnostics publish */
  private waiters = new Map<string, Array<() => void>>();

  /** Store diagnostics for a URI and resolve any pending waiters. */
  publish(uri: string, items: DiagnosticItem[]): void {
    this.cache.set(uri, items);
    const pending = this.waiters.get(uri);
    if (pending) {
      this.waiters.delete(uri);
      for (const resolve of pending) resolve();
    }
  }

  /** Wait for the first diagnostics publish for this URI (with timeout). */
  async waitForFirst(uri: string): Promise<void> {
    if (this.cache.has(uri)) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, DIAG_WAIT_TIMEOUT_MS);
      const waiters = this.waiters.get(uri) ?? [];
      waiters.push(() => { clearTimeout(timeout); resolve(); });
      this.waiters.set(uri, waiters);
    });
  }

  /** Get cached diagnostics for a URI. */
  get(uri: string): DiagnosticItem[] {
    return this.cache.get(uri) ?? [];
  }

  /** Check if diagnostics exist for a URI. */
  has(uri: string): boolean {
    return this.cache.has(uri);
  }

  /** Remove cached diagnostics for a URI. */
  delete(uri: string): void {
    this.cache.delete(uri);
    this.waiters.delete(uri);
  }

  /** Clear all cached diagnostics. */
  clear(): void {
    this.cache.clear();
    this.waiters.clear();
  }
}
