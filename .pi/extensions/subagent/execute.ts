/**
 * Core execution for persistent in-process subagents.
 */

import { agentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { slugify } from "../_shared/slug";
import { ToolCapability, type SubagentDetails, type UsageStats } from "./types";
import { isResolutionOk, resolveSubagentExecutionPlan, type SubagentParams } from "./resolver";

function getFinalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text as string;
    }
  }
  return "";
}

export function getSubagentSessionName(name: string): string {
  return `sub-${slugify(name, { fallback: "agent" })}`;
}

export function hasReachedTurnLimit(turns: number, maxTurns: number | undefined): boolean {
  return maxTurns !== undefined && turns >= maxTurns;
}

interface PersistentSubagentSession {
  manager: SessionManager;
  file?: string;
  id: string;
  name: string;
}

export function createPersistentSubagentSession(name: string, ctx: ExtensionContext): PersistentSubagentSession {
  const manager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir(), {
    parentSession: ctx.sessionManager.getSessionFile(),
  });
  const sessionName = getSubagentSessionName(name);
  manager.appendSessionInfo(sessionName);
  manager.appendThinkingLevelChange("off");
  return { manager, file: manager.getSessionFile(), id: manager.getSessionId(), name: sessionName };
}

export function buildErrorDetails(
  params: SubagentParams,
  toolNames: string[],
  modelOverride: string | undefined,
  reason: string,
): SubagentDetails {
  return {
    name: params.name ?? "unnamed",
    task: params.task,
    agent: params.agent,
    toolNames,
    modelOverride,
    maxTurns: params.max_turns,
    finalOutput: "",
    toolCallCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    stopReason: reason,
    isError: true,
    turnLimitExceeded: false,
  };
}

export interface RunSubagentOptions {
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  signal?: AbortSignal;
}

/** Execute one subagent and record its complete transcript in a child session. */
export async function runSubagent(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: Map<string, AgentTool<any, any>>,
  registeredExtCaps: Map<string, ToolCapability[]> | undefined,
  options: RunSubagentOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
  const plan = resolveSubagentExecutionPlan(params, ctx, registeredExtTools, registeredExtCaps);
  if (!isResolutionOk(plan)) {
    return {
      content: [{ type: "text", text: plan.error.message }],
      details: buildErrorDetails(params, plan.error.toolNames, plan.error.modelOverride ?? params.model, plan.error.reason),
    };
  }

  const { tools: resolvedTools, toolNames, model: resolvedModel, systemPrompt } = plan.value;
  const name = params.name ?? "unnamed";
  const maxTurns = params.max_turns;
  const childSession = createPersistentSubagentSession(name, ctx);
  childSession.manager.appendModelChange(
    (resolvedModel as AgentLoopConfig["model"]).provider,
    (resolvedModel as AgentLoopConfig["model"]).id,
  );

  const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  let toolCallCount = 0;
  let lastModelId: string | undefined;
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  let turnLimitExceeded = false;
  let finalMessages: AgentMessage[] = [];

  const details = (finalOutput: string, isError: boolean): SubagentDetails => ({
    name,
    task: params.task,
    agent: params.agent,
    toolNames,
    modelOverride: params.model,
    maxTurns,
    sessionFile: childSession.file,
    sessionId: childSession.id,
    sessionName: childSession.name,
    finalOutput,
    toolCallCount,
    usage: { ...usage },
    model: lastModelId,
    stopReason: turnLimitExceeded ? "turn_limit" : lastStopReason,
    errorMessage: lastErrorMessage,
    isError,
    turnLimitExceeded,
  });

  const emitUpdate = (partialMessages: AgentMessage[]) => {
    const output = getFinalOutput(partialMessages) || "(running...)";
    options.onUpdate?.({ content: [{ type: "text", text: output }], details: details(output, false) });
  };

  const config: AgentLoopConfig = {
    model: resolvedModel as AgentLoopConfig["model"],
    convertToLlm,
    getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
    headers: { "X-Initiator": "agent" },
    shouldStopAfterTurn: () => hasReachedTurnLimit(usage.turns, maxTurns),
  };
  const agentContext: AgentContext = { systemPrompt, messages: [], tools: resolvedTools };
  const prompts: AgentMessage[] = [{
    role: "user",
    content: [{ type: "text", text: params.task }],
    timestamp: Date.now(),
  } as any];

  try {
    const stream = agentLoop(prompts, agentContext, config, options.signal);
    for await (const event of stream) {
      const ev = event as AgentEvent;
      if (ev.type === "message_end") {
        childSession.manager.appendMessage(ev.message as any);
        const msg = ev.message as AssistantMessage;
        if (msg.role === "assistant") {
          usage.turns++;
          usage.input += msg.usage?.input ?? 0;
          usage.output += msg.usage?.output ?? 0;
          usage.cacheRead += msg.usage?.cacheRead ?? 0;
          usage.cacheWrite += msg.usage?.cacheWrite ?? 0;
          usage.cost += msg.usage?.cost?.total ?? 0;
          lastModelId ??= msg.model;
          lastStopReason = msg.stopReason;
          lastErrorMessage = msg.errorMessage;
          turnLimitExceeded = hasReachedTurnLimit(usage.turns, maxTurns);
        }
      } else if (ev.type === "tool_execution_start") {
        toolCallCount++;
      } else if (ev.type === "turn_end") {
        emitUpdate(agentContext.messages);
      }
    }
    finalMessages = await stream.result();
  } catch (error: unknown) {
    const aborted = options.signal?.aborted;
    const errorMessage = error instanceof Error ? error.message : String(error);
    lastErrorMessage = aborted ? undefined : errorMessage;
    lastStopReason = aborted ? "aborted" : "error";
    const output = aborted ? "Subagent aborted." : `Subagent error: ${errorMessage}`;
    return { content: [{ type: "text", text: output }], details: details(getFinalOutput(agentContext.messages), true) };
  }

  const output = getFinalOutput(finalMessages.length > 0 ? finalMessages : agentContext.messages);
  const isError = lastStopReason === "error" || lastStopReason === "aborted" || Boolean(lastErrorMessage);
  const resultText = turnLimitExceeded
    ? `${output || "(no output)"}\n\n[Note: Turn limit (${maxTurns}) reached. Output may be incomplete.]`
    : output || "(no output)";
  return { content: [{ type: "text", text: resultText }], details: details(resultText, isError) };
}

export function createExecuteSubagent(
  registeredExtTools: Map<string, AgentTool<any, any>>,
  registeredExtCaps?: Map<string, ToolCapability[]>,
) {
  return async function executeSubagent(
    _toolCallId: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentDetails>> {
    return runSubagent(params, ctx, registeredExtTools, registeredExtCaps, { signal, onUpdate });
  };
}
