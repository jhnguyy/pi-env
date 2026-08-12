import { Schema } from "effect";

import { decodeSettingsBlockSync } from "../_shared/settings";

export const DEFAULT_SUBAGENT_LIMITS = {
  maxConcurrentRuns: 4,
  maxPendingRuns: 16,
  maxQueuedJobs: 16,
  maxRetainedJobs: 32,
  maxResultBytes: 50 * 1024,
  maxTaskBytes: 4 * 1024,
  maxSessionTokens: 2_000_000,
  maxSessionCostUsd: 25,
  maxRunMs: 30 * 60 * 1000,
  cancellationGraceMs: 500,
} as const;

const MutableStringArray = Schema.mutable(Schema.Array(Schema.String));

export const SubagentSettingsSchema = Schema.Struct({
  allowedModels: Schema.optionalKey(MutableStringArray),
  maxConcurrentRuns: Schema.optionalKey(Schema.Number),
  maxPendingRuns: Schema.optionalKey(Schema.Number),
  maxQueuedJobs: Schema.optionalKey(Schema.Number),
  maxRetainedJobs: Schema.optionalKey(Schema.Number),
  maxResultBytes: Schema.optionalKey(Schema.Number),
  maxTaskBytes: Schema.optionalKey(Schema.Number),
  maxSessionTokens: Schema.optionalKey(Schema.Number),
  maxSessionCostUsd: Schema.optionalKey(Schema.Number),
  maxRunMs: Schema.optionalKey(Schema.Number),
  cancellationGraceMs: Schema.optionalKey(Schema.Number),
});

export interface SubagentRuntimeConfig {
  readonly allowedModels?: readonly string[];
  readonly maxConcurrentRuns: number;
  readonly maxPendingRuns: number;
  readonly maxQueuedJobs: number;
  readonly maxRetainedJobs: number;
  readonly maxResultBytes: number;
  readonly maxTaskBytes: number;
  readonly maxSessionTokens: number;
  readonly maxSessionCostUsd: number;
  readonly maxRunMs: number;
  readonly cancellationGraceMs: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveSubagentRuntimeConfig(
  settings: typeof SubagentSettingsSchema.Type,
  enabledModels: readonly string[] = [],
): SubagentRuntimeConfig {
  const allowedModels = settings.allowedModels;
  void enabledModels;
  return {
    allowedModels: allowedModels ? [...new Set(allowedModels)] : undefined,
    maxConcurrentRuns: positiveInteger(settings.maxConcurrentRuns, DEFAULT_SUBAGENT_LIMITS.maxConcurrentRuns),
    maxPendingRuns: positiveInteger(settings.maxPendingRuns, DEFAULT_SUBAGENT_LIMITS.maxPendingRuns),
    maxQueuedJobs: positiveInteger(settings.maxQueuedJobs, DEFAULT_SUBAGENT_LIMITS.maxQueuedJobs),
    maxRetainedJobs: positiveInteger(settings.maxRetainedJobs, DEFAULT_SUBAGENT_LIMITS.maxRetainedJobs),
    maxResultBytes: positiveInteger(settings.maxResultBytes, DEFAULT_SUBAGENT_LIMITS.maxResultBytes),
    maxTaskBytes: positiveInteger(settings.maxTaskBytes, DEFAULT_SUBAGENT_LIMITS.maxTaskBytes),
    maxSessionTokens: positiveInteger(settings.maxSessionTokens, DEFAULT_SUBAGENT_LIMITS.maxSessionTokens),
    maxSessionCostUsd: positiveNumber(settings.maxSessionCostUsd, DEFAULT_SUBAGENT_LIMITS.maxSessionCostUsd),
    maxRunMs: positiveInteger(settings.maxRunMs, DEFAULT_SUBAGENT_LIMITS.maxRunMs),
    cancellationGraceMs: positiveInteger(settings.cancellationGraceMs, DEFAULT_SUBAGENT_LIMITS.cancellationGraceMs),
  };
}

export function loadSubagentRuntimeConfig(
  cwd: string,
  enabledModels: readonly string[] = [],
): SubagentRuntimeConfig {
  const settings = decodeSettingsBlockSync("subagent", SubagentSettingsSchema, cwd);
  return resolveSubagentRuntimeConfig(settings, enabledModels);
}
