/**
 * Core execution for persistent in-process subagents.
 */

import { agentLoop } from "@earendil-works/pi-agent-core";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Effect } from "effect";

import { slugify } from "../_shared/slug";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { SubagentExecutionError, SubagentExecutionPhase } from "./errors";
import type { SubagentDetails, UsageStats } from "./types";
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

export function createPersistentSubagentSession(name: string, ctx: ExtensionContext, cwd = ctx.cwd): PersistentSubagentSession {
  const manager = SessionManager.create(cwd, ctx.sessionManager.getSessionDir(), {
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
    cwd: params.cwd,
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
async function runSubagentPromise(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
  const plan = resolveSubagentExecutionPlan(params, ctx, registeredExtTools);
  if (!isResolutionOk(plan)) {
    return {
      content: [{ type: "text", text: plan.error.message }],
      details: buildErrorDetails(params, plan.error.toolNames, plan.error.modelOverride ?? params.model, plan.error.reason),
    };
  }

  const { tools: resolvedTools, toolNames, model: resolvedModel, systemPrompt, effectiveCwd } = plan.value;
  const name = params.name ?? "unnamed";
  const maxTurns = params.max_turns;
  const childSession = createPersistentSubagentSession(name, ctx, effectiveCwd);
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
  const transcript: AgentMessage[] = [];

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
    cwd: effectiveCwd,
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
        transcript.push(ev.message as AgentMessage);
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
        emitUpdate(transcript);
      }
    }
    finalMessages = await stream.result();
  } catch (error: unknown) {
    const aborted = options.signal?.aborted;
    const errorMessage = error instanceof Error ? error.message : String(error);
    lastErrorMessage = aborted ? undefined : errorMessage;
    lastStopReason = aborted ? "aborted" : "error";
    const output = aborted ? "Subagent aborted." : `Subagent error: ${errorMessage}`;
    return { content: [{ type: "text", text: output }], details: details(getFinalOutput(transcript), true) };
  }

  const output = getFinalOutput(finalMessages.length > 0 ? finalMessages : transcript);
  const isError = lastStopReason === "error" || lastStopReason === "aborted" || Boolean(lastErrorMessage);
  const resultText = turnLimitExceeded
    ? `${output || "(no output)"}\n\n[Note: Turn limit (${maxTurns}) reached. Output may be incomplete.]`
    : output || "(no output)";
  return { content: [{ type: "text", text: resultText }], details: details(resultText, isError) };
}

export function runSubagentEffect(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions = {},
): Effect.Effect<AgentToolResult<SubagentDetails>, SubagentExecutionError> {
  return Effect.tryPromise({
    try: (effectSignal) => runSubagentPromise(params, ctx, registeredExtTools, {
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, effectSignal]) : effectSignal,
    }),
    catch: (cause) => new SubagentExecutionError({
      phase: SubagentExecutionPhase.Session,
      cause,
    }),
  });
}

/** Promise compatibility boundary for callers outside the Effect workflow. */
export function runSubagent(
  params: SubagentParams,
  ctx: ExtensionContext,
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
  options: RunSubagentOptions = {},
): Promise<AgentToolResult<SubagentDetails>> {
  return Effect.runPromise(runSubagentEffect(params, ctx, registeredExtTools, options));
}

function unexpectedErrorResult(params: SubagentParams, error: SubagentExecutionError): AgentToolResult<SubagentDetails> {
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  const details = buildErrorDetails(params, [], params.model, error.phase);
  details.errorMessage = cause;
  return {
    content: [{ type: "text", text: `Subagent ${error.phase} error: ${cause}` }],
    details,
  };
}

export function createExecuteSubagent(
  registeredExtTools: ReadonlyMap<string, ExtToolRegistration>,
) {
  return async function executeSubagent(
    _toolCallId: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentDetails>> {
    return Effect.runPromise(Effect.catchAll(
      runSubagentEffect(params, ctx, registeredExtTools, { signal, onUpdate }),
      (error) => Effect.succeed(unexpectedErrorResult(params, error)),
    ));
  };
}
