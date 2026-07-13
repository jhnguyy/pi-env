export { formatCapabilities, ToolCapability } from "../_shared/agent-tools";

export const SubagentJobStatus = {
  Queued: "queued",
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type SubagentJobStatus = (typeof SubagentJobStatus)[keyof typeof SubagentJobStatus];

export const SubagentSessionState = {
  Inactive: "inactive",
  Active: "active",
  ShuttingDown: "shutting-down",
} as const;
export type SubagentSessionState =
  (typeof SubagentSessionState)[keyof typeof SubagentSessionState];

export const SubagentJobToolStatus = {
  Usage: "usage",
  List: "list",
} as const;
export type SubagentJobToolStatus =
  (typeof SubagentJobToolStatus)[keyof typeof SubagentJobToolStatus];

export const ResolutionErrorReason = {
  AgentNotFound: "agent_not_found",
  NoTools: "no_tools",
  InvalidTools: "invalid_tools",
  NoModel: "no_model",
  ModelNotFound: "model_not_found",
  InvalidCwd: "invalid_cwd",
} as const;
export type ResolutionErrorReason =
  (typeof ResolutionErrorReason)[keyof typeof ResolutionErrorReason];

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
  status?: SubagentJobRenderStatus;
  name?: string;
  task?: string;
  toolCallCount?: number;
  usage?: UsageStats;
  model?: string;
  sessionName?: string;
  count?: number;
}

export type SubagentJobRenderStatus =
  | SubagentJobStatus
  | SubagentSessionState
  | SubagentJobToolStatus
  | ResolutionErrorReason;

export interface SubagentDetails {
  name: string;
  task: string;
  agent?: string;
  toolNames: string[];
  modelOverride: string | undefined;
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
