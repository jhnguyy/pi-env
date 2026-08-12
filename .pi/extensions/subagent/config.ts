import { Schema } from "effect";

import { decodeSettingsBlockSync } from "../_shared/settings";

export const DEFAULT_SUBAGENT_LIMITS = {
  maxConcurrentRuns: 4,
  maxPendingRuns: 16,
  maxRetainedJobs: 32,
  maxResultBytes: 50 * 1024,
  maxRunMs: 30 * 60 * 1000,
  cancellationGraceMs: 500,
} as const;

export const SubagentSettingsSchema = Schema.Struct({
  maxConcurrentRuns: Schema.optionalKey(Schema.Number),
  maxPendingRuns: Schema.optionalKey(Schema.Number),
  maxRetainedJobs: Schema.optionalKey(Schema.Number),
  maxResultBytes: Schema.optionalKey(Schema.Number),
  maxRunMs: Schema.optionalKey(Schema.Number),
  cancellationGraceMs: Schema.optionalKey(Schema.Number),
});

export interface SubagentRuntimeConfig {
  readonly maxConcurrentRuns: number;
  readonly maxPendingRuns: number;
  readonly maxRetainedJobs: number;
  readonly maxResultBytes: number;
  readonly maxRunMs: number;
  readonly cancellationGraceMs: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveSubagentRuntimeConfig(
  settings: typeof SubagentSettingsSchema.Type,
): SubagentRuntimeConfig {
  return {
    maxConcurrentRuns: positiveInteger(
      settings.maxConcurrentRuns,
      DEFAULT_SUBAGENT_LIMITS.maxConcurrentRuns,
    ),
    maxPendingRuns: positiveInteger(
      settings.maxPendingRuns,
      DEFAULT_SUBAGENT_LIMITS.maxPendingRuns,
    ),
    maxRetainedJobs: positiveInteger(
      settings.maxRetainedJobs,
      DEFAULT_SUBAGENT_LIMITS.maxRetainedJobs,
    ),
    maxResultBytes: positiveInteger(
      settings.maxResultBytes,
      DEFAULT_SUBAGENT_LIMITS.maxResultBytes,
    ),
    maxRunMs: positiveInteger(settings.maxRunMs, DEFAULT_SUBAGENT_LIMITS.maxRunMs),
    cancellationGraceMs: positiveInteger(
      settings.cancellationGraceMs,
      DEFAULT_SUBAGENT_LIMITS.cancellationGraceMs,
    ),
  };
}

export function loadSubagentRuntimeConfig(cwd: string): SubagentRuntimeConfig {
  const settings = decodeSettingsBlockSync("subagent", SubagentSettingsSchema, cwd);
  return resolveSubagentRuntimeConfig(settings);
}
