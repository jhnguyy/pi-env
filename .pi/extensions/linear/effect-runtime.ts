import { Effect } from "effect";
import type { LinearExtensionError } from "./domain";

export type LinearEffect<A> = Effect.Effect<A, LinearExtensionError>;

export function runLinear<A>(effect: LinearEffect<A>, signal?: AbortSignal): Promise<A> {
  return Effect.runPromise(effect, signal ? { signal } : undefined);
}
