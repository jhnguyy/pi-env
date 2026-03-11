/**
 * Shared types for the subagent extension.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_TURNS = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SubagentDetails {
  task: string;
  agent?: string;
  toolNames: string[];
  modelOverride: string | undefined;
  finalOutput: string;
  toolCallCount: number;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  isError: boolean;
  turnLimitExceeded: boolean;
}
