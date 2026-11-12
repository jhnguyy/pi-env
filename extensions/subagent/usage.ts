import type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SessionStats } from "@earendil-works/pi-coding-agent";

import type * as Types from "./types";

export const zeroUsage = (): Types.UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
});

export function usageFromSessionStats(
  stats: Pick<SessionStats, "tokens" | "cost" | "assistantMessages">,
): Types.UsageStats {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
    cost: stats.cost,
    turns: stats.assistantMessages,
  };
}

export function addUsage(
  target: Types.UsageStats,
  addition: Partial<Types.UsageStats> | undefined,
): Types.UsageStats {
  if (!addition) return target;
  target.input += addition.input ?? 0;
  target.output += addition.output ?? 0;
  target.cacheRead += addition.cacheRead ?? 0;
  target.cacheWrite += addition.cacheWrite ?? 0;
  target.cost += addition.cost ?? 0;
  target.turns += addition.turns ?? 0;
  return target;
}

export function cloneUsage(usage: Types.UsageStats): Types.UsageStats {
  return { ...usage };
}

export function formatUsageCompact(usage: Types.UsageStats): string {
  const cost = Number.isFinite(usage.cost) && usage.cost > 0 ? ` $${usage.cost.toFixed(4)}` : "";
  return `${usage.turns}t in:${usage.input} out:${usage.output} cache:${usage.cacheRead}/${usage.cacheWrite}${cost}`;
}

export interface SubagentRunMetadata {
  name: string;
  task: string;
  toolNames: string[];
  modelOverride: string | undefined;
  maxTurns?: number;
  sessionFile?: string;
  sessionId: string;
  sessionName: string;
  cwd: string;
}

export class SubagentRunAccumulator {
  private lastOutput = "";
  // Run-local diagnostics, unlike cumulative native session usage (which includes follow-ups).
  assistantTurnCount = 0;
  toolCallCount = 0;
  lastModelId: string | undefined;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  turnLimitExceeded = false;

  constructor(
    private readonly metadata: SubagentRunMetadata,
    private readonly hasReachedLimit: (turns: number) => boolean,
    private readonly readUsage: () => Types.UsageStats,
  ) {}

  get usage(): Types.UsageStats {
    return this.readUsage();
  }

  acceptEvent(event: AgentEvent): void {
    if (event.type === "message_end") {
      const message = event.message;
      if (message.role === "assistant") {
        this.assistantTurnCount++;
        this.lastOutput = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n");
        this.lastModelId = message.model;
        this.lastStopReason = message.stopReason;
        this.lastErrorMessage = message.errorMessage;
        this.turnLimitExceeded =
          this.hasReachedLimit(this.assistantTurnCount) && message.stopReason !== "stop";
      }
      return;
    }
    if (event.type === "tool_execution_start") this.toolCallCount++;
  }

  output(): string {
    return this.lastOutput;
  }

  progressResult(): AgentToolResult<Types.SubagentDetails> {
    const output = this.output() || "(running...)";
    return { content: [{ type: "text", text: output }], details: this.details(output, false) };
  }

  failure(error: unknown, aborted: boolean): AgentToolResult<Types.SubagentDetails> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.lastErrorMessage = aborted ? undefined : errorMessage;
    this.lastStopReason = aborted ? "aborted" : "error";
    const text = aborted ? "Subagent aborted." : `Subagent error: ${errorMessage}`;
    return { content: [{ type: "text", text }], details: this.details(this.output(), true) };
  }

  success(): AgentToolResult<Types.SubagentDetails> {
    const output = this.output();
    const isError =
      this.lastStopReason === "error" ||
      this.lastStopReason === "aborted" ||
      Boolean(this.lastErrorMessage);
    const text = this.turnLimitExceeded
      ? `${output || "(no output)"}\n\n[Note: Turn limit (${this.metadata.maxTurns}) reached. Output may be incomplete.]`
      : output || "(no output)";
    return { content: [{ type: "text", text }], details: this.details(text, isError) };
  }

  private details(finalOutput: string, isError: boolean): Types.SubagentDetails {
    return {
      ...this.metadata,
      finalOutput,
      toolCallCount: this.toolCallCount,
      usage: cloneUsage(this.usage),
      model: this.lastModelId,
      stopReason: this.turnLimitExceeded ? "turn_limit" : this.lastStopReason,
      errorMessage: this.lastErrorMessage,
      isError,
      turnLimitExceeded: this.turnLimitExceeded,
    };
  }
}

export const SubagentUsageMode = {
  Sync: "sync",
  Async: "async",
} as const;
export type SubagentUsageMode = (typeof SubagentUsageMode)[keyof typeof SubagentUsageMode];
