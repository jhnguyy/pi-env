import { Effect } from "effect";
import { asLinearError, type LinearExtensionError } from "./domain";

export type LinearEffect<A> = Effect.Effect<A, LinearExtensionError>;

export function linearTryPromise<A>(
  operation: (signal: AbortSignal) => PromiseLike<A>,
): LinearEffect<A> {
  return Effect.tryPromise({ try: operation, catch: asLinearError });
}

export function runLinear<A>(effect: LinearEffect<A>, signal?: AbortSignal): Promise<A> {
  return Effect.runPromise(effect, signal ? { signal } : undefined);
}
