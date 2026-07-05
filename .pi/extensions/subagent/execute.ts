/**
 * execute.ts — core execution logic for the subagent tool.
 *
 * createExecuteSubagent() returns the tool execute function, with
 * registeredExtTools injected via closure so the pi tool signature stays clean.
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
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { ToolCapability, MAX_TURNS, type SubagentDetails, type UsageStats } from "./types";
import { isResolutionOk, resolveSubagentExecutionPlan, type SubagentParams } from "./resolver";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getFinalOutput(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text as string;
      }
    }
  }
  return "";
}

export function buildErrorDetails(
  task: string,
  toolNames: string[],
  modelOverride: string | undefined,
  reason: string,
): SubagentDetails {
  return {
    task,
    toolNames,
    modelOverride,
    finalOutput: "",
    toolCallCount: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    stopReason: reason,
    isError: true,
    turnLimitExceeded: false,
  };
}

// ─── Execute factory ──────────────────────────────────────────────────────────

/**
 * Returns the tool execute function with registeredExtTools injected via closure.
 * Keeps the pi tool signature clean while supporting extension tool injection.
 */
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
    // ── 1. Resolve execution plan ───────────────────────────────────────
    const plan = resolveSubagentExecutionPlan(params, ctx, registeredExtTools, registeredExtCaps);
    if (!isResolutionOk(plan)) {
      return {
        content: [{ type: "text", text: plan.error.message }],
        details: buildErrorDetails(
          params.task,
          plan.error.toolNames,
          plan.error.modelOverride ?? params.model,
          plan.error.reason,
        ),
      };
    }

    const { tools: resolvedTools, toolNames, model: resolvedModel, systemPrompt } = plan.value;

    // ── 2. Build config ─────────────────────────────────────────────────
    const config: AgentLoopConfig = {
      model: resolvedModel as AgentLoopConfig["model"],
      convertToLlm,
      getApiKey: (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider),
      headers: { "X-Initiator": "agent" },
    };

    // ── 6. Build context + prompts ──────────────────────────────────────
    const agentContext: AgentContext = {
      systemPrompt,
      messages: [],
      tools: resolvedTools,
    };

    const prompts: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: params.task }],
        timestamp: Date.now(),
      } as any,
    ];

    // ── 7. Track state ──────────────────────────────────────────────────
    const usage: UsageStats = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    };
    let toolCallCount = 0;
    let lastModelId: string | undefined;
    let lastStopReason: string | undefined;
    let lastErrorMessage: string | undefined;
    let turnLimitExceeded = false;
    let finalMessages: AgentMessage[] = [];

    const emitUpdate = (partialMessages: AgentMessage[]) => {
      if (!onUpdate) return;
      const output = getFinalOutput(partialMessages) || "(running...)";
      const partial: AgentToolResult<SubagentDetails> = {
        content: [{ type: "text", text: output }],
        details: {
          task: params.task,
          agent: params.agent,
          toolNames: toolNames,
          modelOverride: params.model,
          finalOutput: output,
          toolCallCount,
          usage: { ...usage },
          model: lastModelId,
          stopReason: lastStopReason,
          isError: false,
          turnLimitExceeded: false,
        },
      };
      (onUpdate as AgentToolUpdateCallback<SubagentDetails>)(partial);
    };

    // ── 8. Run agentLoop ────────────────────────────────────────────────
    try {
      const stream = agentLoop(prompts, agentContext, config, signal);

      for await (const event of stream) {
        if (signal?.aborted) break;

        const ev = event as AgentEvent;

        if (ev.type === "message_end") {
          const msg = ev.message as any;
          if (msg.role === "assistant") {
            const asst = msg as AssistantMessage;
            usage.turns++;
            if (asst.usage) {
              usage.input += asst.usage.input ?? 0;
              usage.output += asst.usage.output ?? 0;
              usage.cacheRead += asst.usage.cacheRead ?? 0;
              usage.cacheWrite += asst.usage.cacheWrite ?? 0;
              usage.cost += asst.usage.cost?.total ?? 0;
            }
            if (!lastModelId && asst.model) lastModelId = asst.model;
            if (asst.stopReason) lastStopReason = asst.stopReason;
            if (asst.errorMessage) lastErrorMessage = asst.errorMessage;

            if (usage.turns >= MAX_TURNS) {
              turnLimitExceeded = true;
              break;
            }
          }
        }

        if (ev.type === "tool_execution_start") {
          toolCallCount++;
        }

        if (ev.type === "turn_end") {
          emitUpdate(agentContext.messages);
        }
      }

      finalMessages = await stream.result();
    } catch (err: unknown) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Subagent aborted." }],
          details: {
            task: params.task,
            agent: params.agent,
            toolNames: toolNames,
            modelOverride: params.model,
            finalOutput: getFinalOutput(agentContext.messages),
            toolCallCount,
            usage,
            model: lastModelId,
            stopReason: "aborted",
            isError: true,
            turnLimitExceeded: false,
          },
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Subagent error: ${msg}` }],
        details: {
          task: params.task,
          agent: params.agent,
          toolNames: toolNames,
          modelOverride: params.model,
          finalOutput: "",
          toolCallCount,
          usage,
          model: lastModelId,
          errorMessage: msg,
          isError: true,
          turnLimitExceeded: false,
        },
      };
    }

    // ── 9. Extract result ───────────────────────────────────────────────
    const output = getFinalOutput(
      finalMessages.length > 0 ? finalMessages : agentContext.messages,
    );

    const isError =
      lastStopReason === "error" ||
      lastStopReason === "aborted" ||
      Boolean(lastErrorMessage);

    let resultText = output || "(no output)";
    if (turnLimitExceeded) {
      resultText += `\n\n[Note: Turn limit (${MAX_TURNS}) reached. Output may be incomplete.]`;
    }

    return {
      content: [{ type: "text", text: resultText }],
      details: {
        task: params.task,
        agent: params.agent,
        toolNames: toolNames,
        modelOverride: params.model,
        finalOutput: resultText,
        toolCallCount,
        usage,
        model: lastModelId,
        stopReason: lastStopReason,
        errorMessage: lastErrorMessage,
        isError,
        turnLimitExceeded,
      },
    };
  };
}
