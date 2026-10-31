import { Schema } from "effect";
import { join } from "node:path";

import { decodeSettingsBlockSync, defaultSettingsEnv } from "../_shared/settings";

export const DEFAULT_SUBAGENT_LIMITS = {
  maxConcurrentRuns: 4,
  maxPendingRuns: 16,
  maxRetainedJobs: 32,
  maxRunMs: 30 * 60 * 1000,
} as const;

export const DEFAULT_SUBAGENT_CONFIG = DEFAULT_SUBAGENT_LIMITS;

export const SubagentSettingsSchema = Schema.Struct({
  maxConcurrentRuns: Schema.optionalKey(Schema.Number),
  maxPendingRuns: Schema.optionalKey(Schema.Number),
  maxRetainedJobs: Schema.optionalKey(Schema.Number),
  maxRunMs: Schema.optionalKey(Schema.Number),
});

export interface SubagentRuntimeConfig {
  readonly maxConcurrentRuns: number;
  readonly maxPendingRuns: number;
  readonly maxRetainedJobs: number;
  readonly maxRunMs: number;
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
    maxRunMs: positiveInteger(settings.maxRunMs, DEFAULT_SUBAGENT_LIMITS.maxRunMs),
  };
}

export function loadSubagentRuntimeConfig(cwd: string, agentDir?: string): SubagentRuntimeConfig {
  const env = agentDir === undefined ? defaultSettingsEnv : {
    ...defaultSettingsEnv, globalSettingsPath: () => join(agentDir, "settings.json"),
  };
  const settings = decodeSettingsBlockSync("subagent", SubagentSettingsSchema, cwd, env);
  return resolveSubagentRuntimeConfig(settings);
}
