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
import { Effect } from "effect";

import { slugify } from "../_shared/slug";
import type { ExtToolRegistration } from "../_shared/agent-tools";
import { SubagentExecutionError, SubagentExecutionPhase } from "./errors";
import type { SubagentDetails } from "./types";
import { isResolutionOk, resolveSubagentExecutionPlan, type SubagentParams } from "./resolver";
import { recordSubagentResult, SubagentRunAccumulator, SubagentUsageLedger, SubagentUsageMode, zeroUsage } from "./usage";

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
    usage: zeroUsage(),
    stopReason: reason,
    isError: true,
    turnLimitExceeded: false,
  };
}

export interface RunSubagentOptions {
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  onUsage?: (details: SubagentDetails) => void;
  signal?: AbortSignal;
  ledger?: SubagentUsageLedger;
  runId?: string;
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

  const accumulator = new SubagentRunAccumulator({
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
  }, (turns) => hasReachedTurnLimit(turns, maxTurns));
  const config: AgentLoopConfig = {
    model: resolvedModel as AgentLoopConfig["model"],
    convertToLlm,
    getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
    headers: { "X-Initiator": "agent" },
    shouldStopAfterTurn: () => hasReachedTurnLimit(accumulator.usage.turns, maxTurns),
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
      const appended = accumulator.acceptEvent(ev);
      if (appended) childSession.manager.appendMessage(appended as any);
      if (appended?.role === "assistant") options.onUsage?.(accumulator.progressResult().details);
      if (ev.type === "turn_end") options.onUpdate?.(accumulator.progressResult());
    }
    return recordSubagentResult(
      options.ledger,
      options.runId,
      SubagentUsageMode.Sync,
      accumulator.success(await stream.result()),
    );
  } catch (error: unknown) {
    return recordSubagentResult(
      options.ledger,
      options.runId,
      SubagentUsageMode.Sync,
      accumulator.failure(error, options.signal?.aborted === true),
    );
  }
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
  ledger?: SubagentUsageLedger,
) {
  return async function executeSubagent(
    _toolCallId: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentDetails>> {
    return Effect.runPromise(Effect.catchAll(
      runSubagentEffect(params, ctx, registeredExtTools, { signal, onUpdate, ledger, runId: _toolCallId }),
      (error) => Effect.succeed(unexpectedErrorResult(params, error)),
    ));
  };
}
