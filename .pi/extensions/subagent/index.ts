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

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { discoverAgents } from "./agents";
import { createExecuteSubagent } from "./execute";
import { renderJob, SubagentJobManager } from "./jobs";
import { buildDynamicDescription, STATIC_DESCRIPTION } from "./discovery";
import { renderSubagentCall, renderSubagentResult } from "./render";
import { listenForAgentTools, PiEvent, type ToolCapability } from "../_shared/agent-tools";
import { readOptionalAgentSettings } from "../_shared/agent-settings";

// ─── Parameters schema (stable across re-registrations) ──────────────────────

const SUBAGENT_PARAMETERS = Type.Object({
  name: Type.String({
    description: "Required human-readable child-session name. Stored as a `sub-` prefixed session name.",
  }),
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
  max_turns: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Optional maximum completed assistant turns. Omit to run without a turn-count limit.",
    }),
  ),
});

const SUBAGENT_JOB_PARAMETERS = Type.Object({
  action: StringEnum(["status", "wait", "cancel", "list"] as const, {
    description: "Inspect, wait for, cancel, or list asynchronous subagent jobs.",
  }),
  job_id: Type.Optional(Type.String({ description: "Job ID (required except for list)." })),
});

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Extension tool registration ──────────────────────────────────────────
  // Collect AgentTool instances from other extensions at load time.
  const registeredExtTools = new Map<string, AgentTool<any, any>>();
  const extToolCaps = new Map<string, ToolCapability[]>();
  listenForAgentTools(pi, (registration) => {
    registeredExtTools.set(registration.tool.name, registration.tool);
    extToolCaps.set(registration.tool.name, registration.capabilities);
  });

  // Named execute function — stable reference (no recreation on re-register)
  const executeSubagent = createExecuteSubagent(registeredExtTools, extToolCaps);
  const jobs = new SubagentJobManager(pi, registeredExtTools, extToolCaps);
  const executeAsyncSubagent = async (_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any): Promise<AgentToolResult<any>> => {
    const job = jobs.start(params, ctx);
    return {
      content: [{ type: "text", text: `Started subagent job ${job.id} (${job.name}).` }],
      details: { jobId: job.id, status: job.status },
    };
  };
  const executeSubagentJob = async (_id: string, params: { action: string; job_id?: string }): Promise<AgentToolResult<any>> => {
    if (params.action === "list") {
      const output = jobs.list().map(renderJob).join("\n") || "No subagent jobs.";
      return { content: [{ type: "text", text: output }], details: {} };
    }
    if (!params.job_id) throw new Error("job_id is required for status, wait, and cancel.");
    const job = params.action === "wait"
      ? await jobs.wait(params.job_id)
      : params.action === "cancel"
        ? jobs.cancel(params.job_id)
        : jobs.get(params.job_id);
    if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
    return { content: [{ type: "text", text: renderJob(job) }], details: { jobId: job.id, status: job.status } };
  };

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
  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start a named persistent subagent without waiting. Use subagent_job to inspect, wait for, or cancel it. Jobs stop when the parent session shuts down.",
    parameters: SUBAGENT_PARAMETERS,
    execute: executeAsyncSubagent,
  });
  pi.registerTool({
    name: "subagent_job",
    label: "Subagent Job",
    description: "Inspect, wait for, cancel, or list in-process asynchronous subagent jobs.",
    parameters: SUBAGENT_JOB_PARAMETERS,
    execute: executeSubagentJob,
  });
  pi.on("session_shutdown", () => jobs.shutdown());
  // Re-register last so consumers that retain the latest registration continue
  // to receive the primary synchronous tool.
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

  pi.on(PiEvent.SessionStart, (_event, ctx) => {
    // 1. Read enabled models and annotations from settings.json
    const settings = readOptionalAgentSettings();
    const enabledModelIds = Array.isArray(settings?.enabledModels) ? settings.enabledModels : [];
    const modelAnnotations = settings?.modelAnnotations ?? {};

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
