/** Shared types for the subagent extension. */
export { formatCapabilities, ToolCapability } from "../_shared/agent-tools";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SubagentJobRenderDetails {
  jobId?: string;
  status?: string;
  name?: string;
  task?: string;
  toolCallCount?: number;
  usage?: UsageStats;
  model?: string;
  sessionName?: string;
  count?: number;
}

export interface SubagentDetails {
  name: string;
  task: string;
  agent?: string;
  toolNames: string[];
  modelOverride: string | undefined;
  /** Optional caller-selected limit; omitted means the loop is not turn-limited. */
  maxTurns?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
  finalOutput: string;
  toolCallCount: number;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  isError: boolean;
  turnLimitExceeded: boolean;
}
