import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import { formatJobMetadata, formatJobResult, type SubagentJob } from "../jobs";
import { SubagentJobStatus } from "../types";
import { zeroUsage } from "../usage";

it("preserves native failure diagnostics in job inspection and result text", () => {
  const job: SubagentJob = {
    id: "failed-job",
    name: "audit",
    task: "inspect",
    cwd: "/fixture",
    status: SubagentJobStatus.Failed,
    done: Effect.runSync(Deferred.make<void>()),
    controller: new AbortController(),
    createdAt: "2026-01-01T00:00:00.000Z",
    latestDetails: {
      name: "audit",
      task: "inspect",
      toolNames: [],
      modelOverride: undefined,
      finalOutput: "",
      toolCallCount: 0,
      usage: zeroUsage(),
      isError: true,
      errorMessage: "Connection refused",
      turnLimitExceeded: false,
    },
  };
  expect(formatJobMetadata(job)).toContain("error:Connection refused");
  expect(formatJobResult(job)).toContain("error:Connection refused");
});
