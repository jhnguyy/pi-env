/**
 * Subagent Extension — entry point.
 *
 * Thin wiring only. Business logic lives in:
 *   - execute.ts     — agentLoop execution, tool/model resolution
 *   - render.ts      — TUI renderCall / renderResult
 *   - discovery.ts   — dynamic description builder
 *   - types.ts       — shared types and constants
 *   - agents.ts      — agent file discovery and parsing
 *
 * Two modes:
 * 1. Agent file: subagent({ agent: "scout", task: "..." })
 *    — tools/model/prompt loaded from ~/.pi/agent/agents/<name>.md
 * 2. Inline: subagent({ task: "...", tools: [...], model: "provider/id" })
 *    — explicit config, no defaults applied
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { discoverAgents } from "./agents";
import { createExecuteSubagent } from "./execute";
import { buildDynamicDescription, STATIC_DESCRIPTION } from "./discovery";
import { renderSubagentCall, renderSubagentResult } from "./render";
import type { ExtToolRegistration, ToolCapability } from "./types";

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

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Extension tool registration ──────────────────────────────────────────
  // Collect AgentTool instances from other extensions at load time.
  // Providers emit on "agent-tools:register" during session_start.
  // Expected format: ExtToolRegistration envelope { tool, capabilities }.
  const registeredExtTools = new Map<string, AgentTool<any, any>>();
  const extToolCaps = new Map<string, ToolCapability[]>();
  pi.events.on("agent-tools:register", (data: unknown) => {
    const reg = data as ExtToolRegistration;
    registeredExtTools.set(reg.tool.name, reg.tool);
    extToolCaps.set(reg.tool.name, reg.capabilities);
  });

  // Named execute function — stable reference (no recreation on re-register)
  const executeSubagent = createExecuteSubagent(registeredExtTools, extToolCaps);

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
    // 1. Read enabled models and annotations from settings.json
    let enabledModelIds: string[] = [];
    let modelAnnotations: Record<string, string[]> = {};
    try {
      const settingsPath = path.join(getAgentDir(), "settings.json");
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { enabledModels?: string[]; modelAnnotations?: Record<string, string[]> };
      if (Array.isArray(settings.enabledModels)) {
        enabledModelIds = settings.enabledModels;
      }
      if (settings.modelAnnotations) {
        modelAnnotations = settings.modelAnnotations;
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

    // 4. Re-register with enriched description (including registered extension tools)
    const extToolNames = [...registeredExtTools.keys()];
    const description = buildDynamicDescription(
      enabledModelIds, availableModels, agents, extToolNames, extToolCaps, modelAnnotations,
    );
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
