import type { Usage } from "@earendil-works/pi-ai";

type AggregateUsage = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite"> & { cost: number };

/** Preserve aggregate cost without inventing a per-token cost breakdown. */
export function toNestedToolUsage(usage: AggregateUsage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
  };
}
