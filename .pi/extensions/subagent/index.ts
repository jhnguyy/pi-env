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
 *
 * Two modes:
 * 1. Agent file: subagent({ agent: "scout", task: "..." })
 *    — tools/model/prompt loaded from ~/.pi/agent/agents/<name>.md
 * 2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" })
 *    — explicit config, no defaults applied
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
  getAgentDir,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { discoverAgents, type AgentConfig } from "./agents";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_TURNS = 20;

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

// ─── Parameters schema (stable across re-registrations) ──────────────────────

const SUBAGENT_PARAMETERS = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name — resolves to an agent definition file with tools/model/system prompt configured",
    }),
  ),
  task: Type.String({ description: "Task to delegate to the subagent" }),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tool whitelist. Required when not using an agent file.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Model as 'provider/model-id'. Required when not using an agent file.",
    }),
  ),
  system_prompt: Type.Optional(
    Type.String({
      description:
        "System prompt override. Optional — agent files provide this, or a minimal default is used.",
    }),
  ),
});

// ─── Static description (shown before session_start enrichment) ───────────────

const STATIC_DESCRIPTION = [
  "Delegate a focused task to an in-process subagent running via agentLoop().",
  "The subagent runs inside the parent tool call — abort propagates automatically,",
  "progress streams live to the TUI. No subprocess overhead.",
  "",
  "Two modes:",
  '  1. Agent file: subagent({ agent: "scout", task: "..." }) — tools/model/prompt from the agent definition',
  '  2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" }) — explicit config, no defaults',
  "",
  "Available built-in tools: read, bash, edit, write, grep, find, ls.",
  "Extension tools (lsp, notes, etc.) are available when registered.",
  "Model: 'provider/model-id' format. Required — no default.",
].join("\n");

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
  agent?: string;
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

// ─── Dynamic description builder ─────────────────────────────────────────────

function buildDynamicDescription(
  enabledModelIds: string[],
  availableModels: Array<{ provider: string; id: string; name: string }>,
  agents: AgentConfig[],
): string {
  const lines = [
    "Delegate a focused task to an in-process subagent running via agentLoop().",
    "The subagent runs inside the parent tool call — abort propagates automatically,",
    "progress streams live to the TUI. No subprocess overhead.",
    "",
    "Two modes:",
    '  1. Agent file: subagent({ agent: "scout", task: "..." }) — tools/model/prompt from the agent definition',
    '  2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" }) — explicit config, no defaults',
    "",
    "Available built-in tools: read, bash, edit, write, grep, find, ls.",
    "Extension tools (lsp, notes, etc.) are available when registered.",
  ];

  // Intersect enabled list with models that have working auth
  const enabledSet = new Set(enabledModelIds);
  const listedModels =
    enabledSet.size > 0
      ? availableModels.filter((m) => enabledSet.has(`${m.provider}/${m.id}`))
      : availableModels;

  if (listedModels.length > 0) {
    lines.push("", "Available models (use 'provider/model-id' format):");
    for (const m of listedModels) {
      lines.push(`  ${m.provider}/${m.id} — ${m.name}`);
    }
  } else {
    lines.push("", "Model: 'provider/model-id' format. Required — no default.");
  }

  if (agents.length > 0) {
    lines.push("", "Available agents:");
    for (const a of agents) {
      lines.push(`  ${a.name} (${a.source}): ${a.description}`);
    }
  }

  return lines.join("\n");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Extension tool registration ──────────────────────────────────────────
  // Collect AgentTool instances from other extensions at load time.
  // Providers emit on "agent-tools:register" during session_start.
  const registeredExtTools = new Map<string, AgentTool<any, any>>();
  pi.events.on("agent-tools:register", (data: unknown) => {
    const tool = data as AgentTool<any, any>;
    registeredExtTools.set(tool.name, tool);
  });

  // ── Named execute function (stable reference, closes over registeredExtTools) ──

  async function executeSubagent(
    _toolCallId: string,
    params: { agent?: string; task: string; tools?: string[]; model?: string; system_prompt?: string },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentDetails>> {
    // ── 1. Resolve agent file if specified ─────────────────────────────
    let agentConfig: AgentConfig | undefined;
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
    // Agent file → inline param → error (no defaults)
    const rawToolNames: string[] | undefined = agentConfig?.tools ?? params.tools;
    if (!rawToolNames || rawToolNames.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No tools specified. Provide tools in the agent file or pass the tools parameter.",
          },
        ],
        details: buildErrorDetails(params.task, [], params.model, "no_tools"),
      };
    }

    const resolvedTools: AgentTool<any, any>[] = [];
    const unknownTools: string[] = [];
    for (const name of rawToolNames) {
      if (name in TOOL_FACTORIES) {
        resolvedTools.push(TOOL_FACTORIES[name](ctx.cwd));
      } else if (registeredExtTools.has(name)) {
        resolvedTools.push(registeredExtTools.get(name)!);
      } else {
        unknownTools.push(name);
      }
    }
    if (unknownTools.length > 0) {
      const available = [
        ...Object.keys(TOOL_FACTORIES),
        ...registeredExtTools.keys(),
      ].join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Unknown tools: ${unknownTools.join(", ")}. Available: ${available}`,
          },
        ],
        details: buildErrorDetails(params.task, rawToolNames, params.model, "invalid_tools"),
      };
    }

    // ── 3. Resolve model ────────────────────────────────────────────────
    // Agent file → inline param → error (no fallback to parent model)
    const modelStr: string | undefined = params.model ?? agentConfig?.model;
    if (!modelStr) {
      return {
        content: [
          {
            type: "text",
            text: "No model specified. Provide model in the agent file or pass the model parameter.",
          },
        ],
        details: buildErrorDetails(params.task, rawToolNames, params.model, "no_model"),
      };
    }

    let resolvedModel;
    const slashIdx = modelStr.indexOf("/");
    if (slashIdx !== -1) {
      // provider/model-id format — exact lookup
      resolvedModel = ctx.modelRegistry.find(
        modelStr.slice(0, slashIdx),
        modelStr.slice(slashIdx + 1),
      );
    } else {
      // Bare model name (e.g. from agent file) — search across all providers
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
        details: buildErrorDetails(params.task, rawToolNames, modelStr, "model_not_found"),
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
          toolNames: rawToolNames,
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
            agent: params.agent,
            toolNames: rawToolNames,
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
          toolNames: rawToolNames,
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
        toolNames: rawToolNames,
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
  }

  // ── renderCall ────────────────────────────────────────────────────────────

  function renderSubagentCall(
    args: { agent?: string; task?: string; tools?: string[]; model?: string },
    theme: any,
  ) {
    const task = args.task ?? "";
    const preview = task.length > 70 ? `${task.slice(0, 70)}...` : task;
    const agentStr = args.agent
      ? theme.fg("accent", args.agent as string) + " "
      : "";
    const tools = args.tools as string[] | undefined;
    const toolsStr = tools ? `[${tools.join(", ")}]` : "";
    const modelStr = args.model ? ` (${args.model})` : "";
    const text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      agentStr +
      theme.fg("dim", `${toolsStr}${modelStr}`) +
      "\n  " +
      theme.fg("toolOutput", preview);
    return new Text(text, 0, 0);
  }

  // ── renderResult ──────────────────────────────────────────────────────────

  function renderSubagentResult(
    result: AgentToolResult<SubagentDetails>,
    { expanded }: { expanded: boolean },
    theme: any,
  ) {
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
      if (details.agent) {
        header += ` ${theme.fg("accent", details.agent)}`;
      }
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
    if (details.agent) {
      text += ` ${theme.fg("accent", details.agent)}`;
    }
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
  }

  // ── Initial registration (static description) ─────────────────────────────

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: STATIC_DESCRIPTION,
    parameters: SUBAGENT_PARAMETERS,
    execute: executeSubagent,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  });

  // ── session_start: re-register with dynamic model + agent list ────────────

  pi.on("session_start", (_event, ctx) => {
    // 1. Read enabled models from settings.json
    let enabledModelIds: string[] = [];
    try {
      const settingsPath = path.join(getAgentDir(), "settings.json");
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { enabledModels?: string[] };
      if (Array.isArray(settings.enabledModels)) {
        enabledModelIds = settings.enabledModels;
      }
    } catch {
      // settings.json missing or malformed — will list all available models
    }

    // 2. Get models that have working auth
    const availableModels = ctx.modelRegistry.getAvailable() as Array<{
      provider: string;
      id: string;
      name: string;
    }>;

    // 3. Discover agents
    const { agents } = discoverAgents(ctx.cwd, "both");

    // 4. Re-register with enriched description
    const description = buildDynamicDescription(enabledModelIds, availableModels, agents);
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description,
      parameters: SUBAGENT_PARAMETERS,
      execute: executeSubagent,
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
    });
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
