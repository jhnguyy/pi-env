/**
 * Shared types for the subagent extension.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";

// ─── Constants ────────────────────────────────────────────────────────────────

export const MAX_TURNS = 20;

// ─── Extension Tool Registration ──────────────────────────────────────────────

/**
 * Capability tags for extension tool registration.
 *
 * Describes what a tool can DO, not what domain it belongs to.
 * Consumers filter by capability to enforce scope boundaries:
 *
 *   "read"    — observes state (queries, lookups, searches). Safe for scouts.
 *   "write"   — modifies state (file edits, note writes, message sends).
 *   "execute" — runs code or spawns processes (bash, subagent).
 *
 * A tool can have multiple tags. A read-only tool like dev-tools gets ["read"].
 * A tool like bus that can observe, send messages, and create sessions gets all three.
 */
export type ToolCapability = "read" | "write" | "execute";

/**
 * Payload for the "agent-tools:register" event.
 *
 * Extensions emit this during session_start to make their tools available
 * to in-process subagents. Required format — no bare AgentTool.
 */
export interface ExtToolRegistration {
  tool: AgentTool<any, any>;
  /** What this tool can do. Used by subagent consumers to filter by scope. */
  capabilities: ToolCapability[];
}

/** Format capabilities for display: "read, write" */
export function formatCapabilities(caps: ToolCapability[]): string {
  return caps.join(", ");
}

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
