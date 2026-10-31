export const SubagentJobStatus = {
  Queued: "queued",
  Running: "running",
  Cancelling: "cancelling",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
  Interrupted: "interrupted",
  Rejected: "rejected",
} as const;
export type SubagentJobStatus = (typeof SubagentJobStatus)[keyof typeof SubagentJobStatus];

export const SubagentSessionState = {
  Inactive: "inactive",
  Active: "active",
  ShuttingDown: "shutting-down",
} as const;
export type SubagentSessionState = (typeof SubagentSessionState)[keyof typeof SubagentSessionState];

export const SubagentJobToolStatus = {
  Usage: "usage",
  List: "list",
} as const;
export type SubagentJobToolStatus =
  (typeof SubagentJobToolStatus)[keyof typeof SubagentJobToolStatus];

export const ResolutionErrorReason = {
  InvalidTools: "invalid_tools",
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
  childId?: string;
  status?: SubagentJobRenderStatus;
  name?: string;
  task?: string;
  toolCallCount?: number;
  usage?: UsageStats;
  model?: string;
  sessionName?: string;
  sessionFile?: string;
  count?: number;
  resultTruncated?: boolean;
}

export type SubagentJobRenderStatus =
  | SubagentJobStatus
  | SubagentSessionState
  | SubagentJobToolStatus
  | ResolutionErrorReason;

export interface SubagentDetails {
  jobId?: string;
  childId?: string;
  resultTruncated?: boolean;
  name: string;
  task: string;
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
