import type { AgentEvent, AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type * as Types from "./types";

export const zeroUsage = (): Types.UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
});

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

export function getFinalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.role !== "assistant") continue;
    const textParts: string[] = [];
    for (const part of msg.content) {
      if (part.type === "text") textParts.push(part.text as string);
    }
    return textParts.join("\n");
  }
  return "";
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
  readonly usage = zeroUsage();
  readonly transcript: AgentMessage[] = [];
  toolCallCount = 0;
  lastModelId: string | undefined;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  turnLimitExceeded = false;

  constructor(
    private readonly metadata: SubagentRunMetadata,
    private readonly hasReachedLimit: (turns: number) => boolean,
  ) {}

  acceptEvent(event: AgentEvent): AgentMessage | undefined {
    if (event.type === "message_end") {
      const message = event.message;
      this.transcript.push(message);
      this.acceptMessageUsage(message);
      return message;
    }
    if (event.type === "tool_execution_start") this.toolCallCount++;
    return undefined;
  }

  output(messages: AgentMessage[] = this.transcript): string {
    return getFinalOutput(messages);
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

  success(finalMessages: AgentMessage[]): AgentToolResult<Types.SubagentDetails> {
    const output = this.output(finalMessages.length > 0 ? finalMessages : this.transcript);
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

  private acceptMessageUsage(message: AgentMessage): void {
    if (message.role === "toolResult") {
      addUsage(this.usage, {
        input: message.usage?.input ?? 0,
        output: message.usage?.output ?? 0,
        cacheRead: message.usage?.cacheRead ?? 0,
        cacheWrite: message.usage?.cacheWrite ?? 0,
        cost: message.usage?.cost?.total ?? 0,
      });
      return;
    }
    const msg = message as AssistantMessage;
    if (msg.role !== "assistant") return;
    addUsage(this.usage, {
      turns: 1,
      input: msg.usage?.input ?? 0,
      output: msg.usage?.output ?? 0,
      cacheRead: msg.usage?.cacheRead ?? 0,
      cacheWrite: msg.usage?.cacheWrite ?? 0,
      cost: msg.usage?.cost?.total ?? 0,
    });
    this.lastModelId ??= msg.model;
    this.lastStopReason = msg.stopReason;
    this.lastErrorMessage = msg.errorMessage;
    const completed = msg.stopReason === "stop";
    this.turnLimitExceeded = this.hasReachedLimit(this.usage.turns) && !completed;
  }
}

export const SubagentUsageMode = {
  Sync: "sync",
  Async: "async",
} as const;
export type SubagentUsageMode = (typeof SubagentUsageMode)[keyof typeof SubagentUsageMode];

export interface SubagentUsageRecord {
  id: string;
  name: string;
  mode: SubagentUsageMode;
  usage: Types.UsageStats;
}

export function recordSubagentResult(
  ledger: SubagentUsageLedger | undefined,
  id: string | undefined,
  mode: SubagentUsageMode,
  result: AgentToolResult<Types.SubagentDetails>,
): AgentToolResult<Types.SubagentDetails> {
  if (ledger && id) ledger.record(id, mode, result.details);
  return result;
}

export class SubagentUsageLedger {
  private readonly records = new Map<string, SubagentUsageRecord>();

  record(id: string, mode: SubagentUsageMode, details: Types.SubagentDetails): void {
    if (this.records.has(id)) return;
    this.records.set(id, {
      id,
      mode,
      name: details.name,
      usage: cloneUsage(details.usage),
    });
  }

  clear(): void {
    this.records.clear();
  }

  rows(): SubagentUsageRecord[] {
    return [...this.records.values()];
  }

  total(): Types.UsageStats {
    return this.rows().reduce((total, record) => addUsage(total, record.usage), zeroUsage());
  }

  render(): string {
    const rows = this.rows();
    if (rows.length === 0) return "No subagent usage recorded.";
    return [
      ...rows.map((row) => `${row.mode} ${row.id} ${row.name}: ${formatUsageCompact(row.usage)}`),
      `total: ${formatUsageCompact(this.total())}`,
    ].join("\n");
  }
}
