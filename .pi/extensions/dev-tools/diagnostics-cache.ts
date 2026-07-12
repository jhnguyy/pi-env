/** DiagnosticsCache — manages per-URI diagnostic state and waiter queues. */

import { Deferred, Effect } from "effect";
import type { DiagnosticItem } from "./protocol";

export const DIAG_WAIT_TIMEOUT_MS = 2_500;
export const DIAG_SETTLE_MS = 2_000;

type Waiter = {
  deferred: Deferred.Deferred<void, never>;
  timer: ReturnType<typeof setTimeout>;
};

export class DiagnosticsCache {
  private cache = new Map<string, DiagnosticItem[]>();
  private waiters = new Map<string, Waiter[]>();
  private revisions = new Map<string, number>();
  private settledRevisions = new Map<string, number>();

  publish(uri: string, items: DiagnosticItem[]): void {
    this.cache.set(uri, items);
    this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
    this.settleWaiters(uri);
  }

  async waitForFirst(uri: string, timeoutMs = DIAG_WAIT_TIMEOUT_MS): Promise<void> {
    if (this.cache.has(uri)) return;
    const deferred = Effect.runSync(Deferred.make<void>());
    const waiter: Waiter = {
      deferred,
      timer: setTimeout(() => {
        this.removeWaiter(uri, waiter);
        Effect.runSync(Deferred.succeed(deferred, undefined));
      }, timeoutMs),
    };
    const waiters = this.waiters.get(uri) ?? [];
    waiters.push(waiter);
    this.waiters.set(uri, waiters);
    await Effect.runPromise(Deferred.await(deferred));
  }

  async waitForSettled(uri: string, settleMs = DIAG_SETTLE_MS, timeoutMs = DIAG_WAIT_TIMEOUT_MS): Promise<void> {
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

  get(uri: string): DiagnosticItem[] { return this.cache.get(uri) ?? []; }
  has(uri: string): boolean { return this.cache.has(uri); }

  delete(uri: string): void {
    this.cache.delete(uri);
    this.settleWaiters(uri);
    this.revisions.delete(uri);
    this.settledRevisions.delete(uri);
  }

  clear(): void {
    for (const uri of this.waiters.keys()) this.settleWaiters(uri);
    this.cache.clear();
    this.revisions.clear();
    this.settledRevisions.clear();
  }

  private settleWaiters(uri: string): void {
    const pending = this.waiters.get(uri);
    if (!pending) return;
    this.waiters.delete(uri);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      Effect.runSync(Deferred.succeed(waiter.deferred, undefined));
    }
  }

  private removeWaiter(uri: string, waiter: Waiter): void {
    const pending = this.waiters.get(uri);
    if (!pending) return;
    const next = pending.filter((item) => item !== waiter);
    if (next.length) this.waiters.set(uri, next);
    else this.waiters.delete(uri);
  }
}
