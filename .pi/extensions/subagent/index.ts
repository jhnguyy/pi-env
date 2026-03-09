/**
 * Subagent Extension — In-Process Focused Mode
 *
 * Provides a `subagent` tool that runs subtasks in-process via agentLoop()
 * instead of spawning separate `pi` processes. Single-task focused mode only.
 *
 * Benefits over subprocess spawning:
 * - No process overhead / cold start
 * - Abort propagates automatically via AbortSignal
 * - Live progress streams to parent TUI via onUpdate
 * - No extra context window cost for system prompt re-init
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
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_TURNS = 20;

const DEFAULT_SYSTEM_PROMPT =
  "You are a focused subagent. Complete the task using only the tools provided. " +
  "Be concise and direct. Return your findings as clear, structured text.";

// ─── Tool factory map ────────────────────────────────────────────────────────

const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any, any>> = {
  read: (cwd) => createReadTool(cwd) as AgentTool<any, any>,
  bash: (cwd) => createBashTool(cwd) as AgentTool<any, any>,
  edit: (cwd) => createEditTool(cwd) as AgentTool<any, any>,
  write: (cwd) => createWriteTool(cwd) as AgentTool<any, any>,
  grep: (cwd) => createGrepTool(cwd) as AgentTool<any, any>,
  find: (cwd) => createFindTool(cwd) as AgentTool<any, any>,
  ls: (cwd) => createLsTool(cwd) as AgentTool<any, any>,
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface SubagentDetails {
  task: string;
  toolNames: string[];
  modelOverride: string | undefined;
  finalOutput: string;
  toolCallCount: number;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  isError: boolean;
  turnLimitExceeded: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns !== 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

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

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",

    description: [
      "Delegate a focused task to an in-process subagent running via agentLoop().",
      "The subagent runs inside the parent tool call — abort propagates automatically,",
      "progress streams live to the TUI. No subprocess overhead.",
      "",
      "Usage:",
      '  subagent({ task: "Read src/auth/ and summarize the auth flow" })',
      '  subagent({ task: "Find all TODO comments", tools: ["read", "bash"] })',
      '  subagent({ task: "Analyze the schema", model: "anthropic/claude-haiku-4-5" })',
      "",
      "Available tools: read, bash, edit, write, grep, find, ls. Default: read, bash.",
      "Model override: 'provider/model-id' format.",
    ].join("\n"),

    parameters: Type.Object({
      task: Type.String({ description: "Task to delegate to the subagent" }),
      tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Tool whitelist. Available: read, bash, edit, write, grep, find, ls. Default: [read, bash]",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Model override as 'provider/model-id'. Default: inherit parent model",
        }),
      ),
      system_prompt: Type.Optional(
        Type.String({
          description: "System prompt override. Default: minimal task-focused prompt",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // ── 1. Resolve tools ────────────────────────────────────────────────
      const toolNames = params.tools ?? ["read", "bash"];
      const unknownTools = toolNames.filter((t: string) => !(t in TOOL_FACTORIES));
      if (unknownTools.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tools: ${unknownTools.join(", ")}. Available: ${Object.keys(TOOL_FACTORIES).join(", ")}`,
            },
          ],
          details: buildErrorDetails(params.task, toolNames, params.model, "invalid_tools"),
        };
      }
      const resolvedTools: AgentTool<any, any>[] = toolNames.map((t: string) => TOOL_FACTORIES[t](ctx.cwd));

      // ── 2. Resolve model ────────────────────────────────────────────────
      let resolvedModel = ctx.model;
      if (params.model) {
        const slashIdx = params.model.indexOf("/");
        if (slashIdx === -1) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid model format: "${params.model}". Use "provider/model-id".`,
              },
            ],
            details: buildErrorDetails(params.task, toolNames, params.model, "invalid_model_format"),
          };
        }
        const provider = params.model.slice(0, slashIdx);
        const modelId = params.model.slice(slashIdx + 1);
        resolvedModel = ctx.modelRegistry.find(provider, modelId);
        if (!resolvedModel) {
          return {
            content: [
              {
                type: "text",
                text: `Model not found: "${params.model}". Check the model ID and provider name.`,
              },
            ],
            details: buildErrorDetails(params.task, toolNames, params.model, "model_not_found"),
          };
        }
      }

      if (!resolvedModel) {
        return {
          content: [{ type: "text", text: "No model available. Select a model first." }],
          details: buildErrorDetails(params.task, toolNames, params.model, "no_model"),
        };
      }

      // ── 3. Build config ─────────────────────────────────────────────────
      const config: AgentLoopConfig = {
        model: resolvedModel,
        convertToLlm,
        getApiKey: (provider) => ctx.modelRegistry.getApiKeyForProvider(provider),
        headers: { "X-Initiator": "agent" },
      };

      // ── 4. Build context + prompts ──────────────────────────────────────
      const agentContext: AgentContext = {
        systemPrompt: params.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
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

      // ── 5. Track state ──────────────────────────────────────────────────
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
            toolNames,
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

      // ── 6. Run agentLoop ────────────────────────────────────────────────
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

              // Turn limit guard
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
              toolNames,
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
            toolNames,
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

      // ── 7. Extract result ───────────────────────────────────────────────
      const output = getFinalOutput(finalMessages.length > 0 ? finalMessages : agentContext.messages);

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
          toolNames,
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
    },

    // ── renderCall ──────────────────────────────────────────────────────────
    renderCall(args, theme) {
      const task = args.task ?? "";
      const preview = task.length > 70 ? `${task.slice(0, 70)}...` : task;
      const tools = (args.tools as string[] | undefined) ?? ["read", "bash"];
      const modelStr = args.model ? ` (${args.model})` : "";
      const text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("dim", `[${tools.join(", ")}]${modelStr}`) +
        "\n  " +
        theme.fg("toolOutput", preview);
      return new Text(text, 0, 0);
    },

    // ── renderResult ────────────────────────────────────────────────────────
    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;

      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const icon = details.isError
        ? theme.fg("error", "✗")
        : details.turnLimitExceeded
          ? theme.fg("warning", "⚠")
          : theme.fg("success", "✓");

      const usageStr = formatUsageStats(details.usage, details.model);
      const toolsStr =
        details.toolCallCount > 0
          ? `${details.toolCallCount} tool call${details.toolCallCount !== 1 ? "s" : ""}`
          : "";

      if (expanded) {
        const mdTheme = getMarkdownTheme();
        const container = new Container();

        // Header
        let header = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
        if (details.isError && details.stopReason) {
          header += ` ${theme.fg("error", `[${details.stopReason}]`)}`;
        }
        if (details.turnLimitExceeded) {
          header += ` ${theme.fg("warning", `[turn limit: ${MAX_TURNS}]`)}`;
        }
        container.addChild(new Text(header, 0, 0));

        // Stats line
        const statParts: string[] = [];
        if (toolsStr) statParts.push(toolsStr);
        if (details.modelOverride) statParts.push(`model: ${details.modelOverride}`);
        if (statParts.length > 0) {
          container.addChild(new Text(theme.fg("muted", statParts.join(" · ")), 0, 0));
        }

        container.addChild(new Spacer(1));

        // Task
        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", details.task), 0, 0));
        container.addChild(new Spacer(1));

        // Output
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        if (details.isError && details.errorMessage) {
          container.addChild(new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0));
        } else if (!details.finalOutput || details.finalOutput === "(no output)") {
          container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
        } else {
          container.addChild(new Markdown(details.finalOutput.trim(), 0, 0, mdTheme));
        }

        // Usage
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }

        return container;
      }

      // Collapsed view
      const taskPreview =
        details.task.length > 60 ? `${details.task.slice(0, 60)}...` : details.task;

      let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
      if (details.isError) {
        const msg = details.errorMessage || details.stopReason || "error";
        text += ` ${theme.fg("error", `[${msg}]`)}`;
      }
      if (details.turnLimitExceeded) {
        text += ` ${theme.fg("warning", "[turn limit]")}`;
      }
      text += `\n  ${theme.fg("dim", taskPreview)}`;

      // Output preview (first 3 lines)
      if (details.finalOutput && details.finalOutput !== "(no output)") {
        const lines = details.finalOutput.split("\n").slice(0, 3).join("\n");
        text += `\n${theme.fg("toolOutput", lines)}`;
      }

      // Stats
      const statsLine: string[] = [];
      if (toolsStr) statsLine.push(toolsStr);
      if (usageStr) statsLine.push(usageStr);
      if (statsLine.length > 0) {
        text += `\n${theme.fg("dim", statsLine.join(" · "))}`;
      }

      text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });
}

// ─── Error detail builder ─────────────────────────────────────────────────────

function buildErrorDetails(
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
