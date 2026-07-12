/**
 * DiagnosticsCache — manages per-URI diagnostic state and waiter queues.
 *
 * Extracted from LspBackend to isolate the diagnostic publish/wait lifecycle
 * from subprocess management. One instance per LspBackend.
 */

import type { DiagnosticItem } from "./protocol";

export const DIAG_WAIT_TIMEOUT_MS = 2_500;
export const DIAG_SETTLE_MS = 2_000;

export class DiagnosticsCache {
  /** uri → DiagnosticItem[] */
  private cache = new Map<string, DiagnosticItem[]>();
  /** uri → resolvers waiting for first diagnostics publish */
  private waiters = new Map<string, Array<() => void>>();
  /** uri → publish generation, used to wait for syntax + semantic diagnostics. */
  private revisions = new Map<string, number>();
  /** uri → generation already observed through a settle window. */
  private settledRevisions = new Map<string, number>();

  /** Store diagnostics for a URI and resolve any pending waiters. */
  publish(uri: string, items: DiagnosticItem[]): void {
    this.cache.set(uri, items);
    this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
    const pending = this.waiters.get(uri);
    if (pending) {
      this.waiters.delete(uri);
      for (const resolve of pending) resolve();
    }
  }

  /** Wait for the first diagnostics publish for this URI (with timeout). */
  async waitForFirst(uri: string, timeoutMs = DIAG_WAIT_TIMEOUT_MS): Promise<void> {
    if (this.cache.has(uri)) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      const waiters = this.waiters.get(uri) ?? [];
      waiters.push(() => { clearTimeout(timeout); resolve(); });
      this.waiters.set(uri, waiters);
    });
  }

  /** Wait until syntax, semantic, and plugin diagnostics stop changing briefly. */
  async waitForSettled(
    uri: string,
    settleMs = DIAG_SETTLE_MS,
    timeoutMs = DIAG_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    await this.waitForFirst(uri, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let revision = this.revisions.get(uri) ?? 0;
    if (this.settledRevisions.get(uri) === revision) return;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      const current = this.revisions.get(uri) ?? 0;
      if (current === revision) {
        this.settledRevisions.set(uri, current);
        return;
      }
      revision = current;
    }
    this.settledRevisions.set(uri, this.revisions.get(uri) ?? 0);
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
    this.revisions.delete(uri);
    this.settledRevisions.delete(uri);
  }

  /** Clear all cached diagnostics. */
  clear(): void {
    this.cache.clear();
    this.waiters.clear();
    this.revisions.clear();
    this.settledRevisions.clear();
  }
}
