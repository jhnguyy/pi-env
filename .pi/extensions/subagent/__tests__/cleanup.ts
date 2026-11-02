import { onTestFinished } from "vitest";

// Vitest retains the test failure separately from teardown failures. Register before
// asynchronous preparation so partially constructed fixtures remain owned.
export async function settleOperations(operations: readonly (Promise<unknown> | undefined)[]) {
  const results = await Promise.allSettled(operations.filter((operation) => operation !== undefined));
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Subagent fixture operations failed");
}

export function testCleanup() {
  const steps: (() => unknown | Promise<unknown>)[] = [];
  onTestFinished(async () => {
    const errors: unknown[] = [];
    for (const step of steps) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Subagent fixture cleanup failed");
  });
  return (...next: (() => unknown | Promise<unknown>)[]) => { steps.unshift(...next); };
}
