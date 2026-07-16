import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { DiagnosticsCache } from "../diagnostics-cache";
import type { DiagnosticItem } from "../protocol";

const uri = "file:///effect.ts";
const otherUri = "file:///other.ts";

const effectDiagnostic: DiagnosticItem = {
  line: 2,
  character: 1,
  severity: "error",
  code: "TS3",
  message: "effect(floatingEffect)",
};

const forkFirstWaiters = (
  cache: DiagnosticsCache,
  waiterUri: string,
  count: number,
  timeoutMs = 1_000,
) =>
  Effect.forEach(Array.from({ length: count }), () =>
    cache.waitForFirstEffect(waiterUri, timeoutMs).pipe(Effect.forkChild),
  );

describe("DiagnosticsCache", () => {
  it.effect("waits past the initial publication until the latest revision settles", () =>
    Effect.gen(function* () {
      const cache = new DiagnosticsCache();
      const completed = yield* Deferred.make<void>();
      const waiting = yield* cache.waitForSettledEffect(uri, 10, 100).pipe(
        Effect.andThen(Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      cache.publish(uri, []);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(5);
      cache.publish(uri, [{ ...effectDiagnostic, message: "revision-2" }]);
      yield* TestClock.adjust(5);
      cache.publish(uri, [{ ...effectDiagnostic, message: "revision-3" }]);
      yield* TestClock.adjust(5);
      cache.publish(uri, [effectDiagnostic]);

      yield* TestClock.adjust(14);
      expect(yield* Deferred.isDone(completed)).toBe(false);
      yield* TestClock.adjust(1);
      yield* Fiber.join(waiting);

      expect(cache.get(uri)).toEqual([effectDiagnostic]);
      expect(cache.pendingWaiterCount).toBe(0);
    }),
  );

  it.effect("completes every waiter for one URI without disturbing another URI", () =>
    Effect.gen(function* () {
      const cache = new DiagnosticsCache();
      const uriWaiters = yield* forkFirstWaiters(cache, uri, 100);
      const otherWaiters = yield* forkFirstWaiters(cache, otherUri, 2);
      yield* Effect.yieldNow;
      expect(cache.pendingWaiterCount).toBe(102);

      cache.publish(uri, [effectDiagnostic]);
      yield* Effect.forEach(uriWaiters, Fiber.join, { discard: true });
      expect(cache.pendingWaiterCount).toBe(2);

      cache.publish(otherUri, []);
      yield* Effect.forEach(otherWaiters, Fiber.join, { discard: true });
      expect(cache.pendingWaiterCount).toBe(0);
    }),
  );

  it.effect("removes a waiter when its Effect timeout expires", () =>
    Effect.gen(function* () {
      const cache = new DiagnosticsCache();
      const waiting = yield* cache.waitForFirstEffect(uri, 100).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(cache.pendingWaiterCount).toBe(1);

      yield* TestClock.adjust(99);
      expect(cache.pendingWaiterCount).toBe(1);
      yield* TestClock.adjust(1);
      yield* Fiber.join(waiting);

      expect(cache.pendingWaiterCount).toBe(0);
      expect(cache.get(uri)).toEqual([]);
    }),
  );

  it.effect("completes a settled wait after its first-publication timeout", () =>
    Effect.gen(function* () {
      const cache = new DiagnosticsCache();
      const waiting = yield* cache.waitForSettledEffect(uri, 10, 100).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(cache.pendingWaiterCount).toBe(1);

      yield* TestClock.adjust(100);
      expect(cache.pendingWaiterCount).toBe(0);
      yield* TestClock.adjust(10);
      yield* Fiber.join(waiting);

      expect(cache.get(uri)).toEqual([]);
      expect(cache.pendingWaiterCount).toBe(0);
    }),
  );

  it.effect("releases pending waiters on delete and clear", () =>
    Effect.gen(function* () {
      const cache = new DiagnosticsCache();
      const deleted = yield* forkFirstWaiters(cache, uri, 2);
      const cleared = yield* forkFirstWaiters(cache, otherUri, 3);
      yield* Effect.yieldNow;
      expect(cache.pendingWaiterCount).toBe(5);

      cache.delete(uri);
      yield* Effect.forEach(deleted, Fiber.join, { discard: true });
      expect(cache.pendingWaiterCount).toBe(3);

      cache.publish(uri, [effectDiagnostic]);
      cache.delete(uri);
      expect(cache.has(uri)).toBe(false);
      expect(cache.get(uri)).toEqual([]);

      cache.publish(uri, [effectDiagnostic]);
      cache.clear();
      yield* Effect.forEach(cleared, Fiber.join, { discard: true });
      expect(cache.pendingWaiterCount).toBe(0);
      expect(cache.has(uri)).toBe(false);
      expect(cache.get(uri)).toEqual([]);
      expect(cache.has(otherUri)).toBe(false);
    }),
  );

  it.effect("removes interrupted Effect waiters", () =>
    Effect.gen(function* () {
      const cache = new DiagnosticsCache();
      const first = yield* cache.waitForFirstEffect(uri).pipe(Effect.forkChild);
      const settled = yield* cache.waitForSettledEffect(uri).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(cache.pendingWaiterCount).toBe(2);

      yield* Fiber.interruptAll([first, settled]);

      expect(cache.pendingWaiterCount).toBe(0);
    }),
  );

  it.effect("preserves zero-argument construction and Promise wait adapters", () =>
    Effect.gen(function* () {
      const cache = new DiagnosticsCache();
      const first = cache.waitForFirst(uri, 100);
      cache.publish(uri, [effectDiagnostic]);
      yield* Effect.promise(() => first);

      yield* Effect.promise(() => cache.waitForSettled(uri, 0, 100));

      expect(cache.get(uri)).toEqual([effectDiagnostic]);
    }),
  );
});
