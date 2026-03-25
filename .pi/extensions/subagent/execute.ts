/**
 * execute.ts — core execution logic for the subagent tool.
 *
 * createExecuteSubagent() returns the tool execute function, with
 * registeredExtTools injected via closure so the pi tool signature stays clean.
 */

import { agentLoop } from "@mariozechner/pi-agent-core";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import {
  convertToLlm,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { discoverAgents } from "./agents";
import { MAX_TURNS, type SubagentDetails, type UsageStats, type ToolCapability } from "./types";

// ─── Tool factory map ─────────────────────────────────────────────────────────

export interface ToolDef {
  factory: (cwd: string) => AgentTool<any, any>;
  capabilities: ToolCapability[];
}

export const BUILT_IN_TOOLS: Record<string, ToolDef> = {
  read:  { factory: (cwd) => createReadTool(cwd) as AgentTool<any, any>,  capabilities: ["read"] },
  bash:  { factory: (cwd) => createBashTool(cwd) as AgentTool<any, any>,  capabilities: ["read", "write", "execute"] },
  edit:  { factory: (cwd) => createEditTool(cwd) as AgentTool<any, any>,  capabilities: ["write"] },
  write: { factory: (cwd) => createWriteTool(cwd) as AgentTool<any, any>, capabilities: ["write"] },
  grep:  { factory: (cwd) => createGrepTool(cwd) as AgentTool<any, any>,  capabilities: ["read"] },
  find:  { factory: (cwd) => createFindTool(cwd) as AgentTool<any, any>,  capabilities: ["read"] },
  ls:    { factory: (cwd) => createLsTool(cwd) as AgentTool<any, any>,    capabilities: ["read"] },
};

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
    params: {
      agent?: string;
      task: string;
      tools?: string[];
      model?: string;
      system_prompt?: string;
    },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentDetails>> {
    // ── 1. Resolve agent file if specified ──────────────────────────────
    let agentConfig: ReturnType<typeof discoverAgents>["agents"][number] | undefined;
    if (params.agent) {
      const discovery = discoverAgents(ctx.cwd, "both");
      agentConfig = discovery.agents.find((a) => a.name === params.agent);
      if (!agentConfig) {
        const available = discovery.agents.map((a) => a.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Agent not found: "${params.agent}". Available: ${available}`,
            },
          ],
          details: buildErrorDetails(params.task, [], params.model, "agent_not_found"),
        };
      }
    }

    // ── 2. Resolve tools ────────────────────────────────────────────────
    // Two mechanisms, unioned when both present:
    //   capabilities: ["read"] — include all tools whose capability tags are
    //     a SUBSET of the requested set. "read" gets tools tagged ["read"]
    //     only, not ["read","write"]. This keeps read-only agents safe.
    //   tools: ["dev-tools","bash"] — include specific tools by name.
    const requestedCaps = agentConfig?.capabilities;
    const rawToolNames: string[] | undefined = agentConfig?.tools ?? params.tools;

    if ((!rawToolNames || rawToolNames.length === 0) && (!requestedCaps || requestedCaps.length === 0)) {
      return {
        content: [
          {
            type: "text",
            text: "No tools or capabilities specified. Provide tools/capabilities in the agent file or pass the tools parameter.",
          },
        ],
        details: buildErrorDetails(params.task, [], params.model, "no_tools"),
      };
    }

    const resolvedToolNames = new Set<string>();

    // Capability-based resolution: subset matching
    if (requestedCaps && requestedCaps.length > 0) {
      const capSet = new Set(requestedCaps);
      // Built-in tools
      for (const [toolName, def] of Object.entries(BUILT_IN_TOOLS)) {
        if (def.capabilities.every((c) => capSet.has(c))) {
          resolvedToolNames.add(toolName);
        }
      }
      // Extension tools
      if (registeredExtCaps) {
        for (const [toolName, caps] of registeredExtCaps) {
          if (caps.every((c) => capSet.has(c))) {
            resolvedToolNames.add(toolName);
          }
        }
      }
    }

    // Explicit tool names: union with capability-resolved tools
    if (rawToolNames) {
      for (const name of rawToolNames) resolvedToolNames.add(name);
    }

    const resolvedTools: AgentTool<any, any>[] = [];
    const unknownTools: string[] = [];
    for (const name of resolvedToolNames) {
      if (name in BUILT_IN_TOOLS) {
        resolvedTools.push(BUILT_IN_TOOLS[name].factory(ctx.cwd));
      } else if (registeredExtTools.has(name)) {
        resolvedTools.push(registeredExtTools.get(name)!);
      } else {
        unknownTools.push(name);
      }
    }
    // Canonical tool name list for details/reporting — always string[]
    const toolNames = [...resolvedToolNames];
    // Only report unknowns for explicitly named tools, not capability matches
    const explicitUnknowns = unknownTools.filter((n) => rawToolNames?.includes(n));
    if (explicitUnknowns.length > 0) {
      const available = [
        ...Object.keys(BUILT_IN_TOOLS),
        ...registeredExtTools.keys(),
      ].join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Unknown tools: ${explicitUnknowns.join(", ")}. Available: ${available}`,
          },
        ],
        details: buildErrorDetails(params.task, rawToolNames ?? [], params.model, "invalid_tools"),
      };
    }

    // ── 3. Resolve model ────────────────────────────────────────────────
    const modelStr: string | undefined = params.model ?? agentConfig?.model;
    if (!modelStr) {
      return {
        content: [
          {
            type: "text",
            text: "No model specified. Provide model in the agent file or pass the model parameter.",
          },
        ],
        details: buildErrorDetails(params.task, toolNames, params.model, "no_model"),
      };
    }

    let resolvedModel;
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx !== -1) {
      resolvedModel = ctx.modelRegistry.find(
        modelStr.slice(0, slashIdx),
        modelStr.slice(slashIdx + 1),
      );
    } else {
      const available = ctx.modelRegistry.getAvailable
        ? ctx.modelRegistry.getAvailable()
        : [];
      resolvedModel = available.find(
        (m: any) => m.id === modelStr || m.id.includes(modelStr),
      );
    }

    if (!resolvedModel) {
      return {
        content: [
          {
            type: "text",
            text: `Model not found: "${modelStr}". Check the model ID and provider name.`,
          },
        ],
        details: buildErrorDetails(params.task, toolNames, modelStr, "model_not_found"),
      };
    }

    // ── 4. Build system prompt ──────────────────────────────────────────
    const systemPrompt =
      params.system_prompt ??
      agentConfig?.systemPrompt ??
      "Complete the task using only the tools provided. Be concise and direct.";

    // ── 5. Build config ─────────────────────────────────────────────────
    const config: AgentLoopConfig = {
      model: resolvedModel,
      convertToLlm,
      getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
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
