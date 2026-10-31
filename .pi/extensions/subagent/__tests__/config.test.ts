import { expect, it } from "vitest";
import { DEFAULT_SUBAGENT_LIMITS, resolveSubagentRuntimeConfig } from "../config";

it("bounds admission settings and retains defaults for invalid limits", () => {
  expect(resolveSubagentRuntimeConfig({})).toEqual(DEFAULT_SUBAGENT_LIMITS);
  expect(resolveSubagentRuntimeConfig({ maxConcurrentRuns: 2, maxPendingRuns: 3, maxRunMs: 1000, maxRetainedJobs: 4 })).toEqual({ maxConcurrentRuns: 2, maxPendingRuns: 3, maxRunMs: 1000, maxRetainedJobs: 4 });
  expect(resolveSubagentRuntimeConfig({ maxConcurrentRuns: NaN, maxPendingRuns: -1, maxRunMs: Infinity, maxRetainedJobs: 0 })).toEqual(DEFAULT_SUBAGENT_LIMITS);
});
