/** DiagnosticsCache — manages per-URI diagnostic state and waiter queues. */

import { Clock, Deferred, Effect } from "effect";
import type { DiagnosticItem } from "./protocol";

export const DIAG_WAIT_TIMEOUT_MS = 2_500;
export const DIAG_SETTLE_MS = 2_000;

type Waiter = Deferred.Deferred<void>;

type RegisteredWaiter = {
  readonly deferred: Waiter;
  readonly registered: boolean;
};

export class DiagnosticsCache {
  private cache = new Map<string, DiagnosticItem[]>();
  private waiters = new Map<string, Set<Waiter>>();
  private revisions = new Map<string, number>();
  private settledRevisions = new Map<string, number>();
  private waiterCount = 0;

  /** Number of Effects currently waiting for a URI's first publication. */
  get pendingWaiterCount(): number {
    return this.waiterCount;
  }

  publish(uri: string, items: DiagnosticItem[]): void {
    this.cache.set(uri, items);
    this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
    this.settleWaiters(uri);
  }

  waitForFirstEffect(
    uri: string,
    timeoutMs = DIAG_WAIT_TIMEOUT_MS,
  ): Effect.Effect<void> {
    return Effect.acquireUseRelease(
      Deferred.make<void>().pipe(
        Effect.map((deferred): RegisteredWaiter => ({
          deferred,
          registered: this.addWaiter(uri, deferred),
        })),
      ),
      ({ deferred, registered }) =>
        registered
          ? Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs), Effect.asVoid)
          : Effect.void,
      ({ deferred, registered }) =>
        registered ? Effect.sync(() => this.removeWaiter(uri, deferred)) : Effect.void,
    );
  }

  waitForFirst(uri: string, timeoutMs = DIAG_WAIT_TIMEOUT_MS): Promise<void> {
    return Effect.runPromise(this.waitForFirstEffect(uri, timeoutMs));
  }

  waitForSettledEffect(
    uri: string,
    settleMs = DIAG_SETTLE_MS,
    timeoutMs = DIAG_WAIT_TIMEOUT_MS,
  ): Effect.Effect<void> {
    const cache = this;
    return Effect.gen(function* () {
      yield* cache.waitForFirstEffect(uri, timeoutMs);
      const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
      let revision = cache.revisions.get(uri) ?? 0;
      if (cache.settledRevisions.get(uri) === revision) return;
      while ((yield* Clock.currentTimeMillis) < deadline) {
        yield* Effect.sleep(settleMs);
        const current = cache.revisions.get(uri) ?? 0;
        if (current === revision) {
          cache.settledRevisions.set(uri, current);
          return;
        }
        revision = current;
      }
      cache.settledRevisions.set(uri, cache.revisions.get(uri) ?? 0);
    });
  }

  waitForSettled(
    uri: string,
    settleMs = DIAG_SETTLE_MS,
    timeoutMs = DIAG_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    return Effect.runPromise(this.waitForSettledEffect(uri, settleMs, timeoutMs));
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

  private addWaiter(uri: string, waiter: Waiter): boolean {
    if (this.cache.has(uri)) return false;
    const pending = this.waiters.get(uri) ?? new Set<Waiter>();
    pending.add(waiter);
    this.waiters.set(uri, pending);
    this.waiterCount++;
    return true;
  }

  private settleWaiters(uri: string): void {
    const pending = this.waiters.get(uri);
    if (!pending) return;
    this.waiters.delete(uri);
    this.waiterCount -= pending.size;
    Effect.runSync(
      Effect.forEach(pending, (waiter) => Deferred.succeed(waiter, undefined), {
        discard: true,
      }),
    );
  }

  private removeWaiter(uri: string, waiter: Waiter): void {
    const pending = this.waiters.get(uri);
    if (!pending || !pending.delete(waiter)) return;
    this.waiterCount--;
    if (pending.size === 0) this.waiters.delete(uri);
  }
}
