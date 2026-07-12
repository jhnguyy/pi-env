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

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Either } from "effect";
import { Type, type Static } from "typebox";

import { discoverAgents } from "./agents";
import { createExecuteSubagent } from "./execute";
import { renderJob, SubagentJobManager } from "./jobs";
import { isResolutionOk, resolveEffectiveCwd, type SubagentParams } from "./resolver";
import { buildDynamicDescription, STATIC_DESCRIPTION } from "./discovery";
import { renderSubagentCall, renderSubagentResult } from "./render";
import { listenForAgentTools, PiEvent, type ExtToolRegistration } from "../_shared/agent-tools";
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
  cwd: Type.Optional(Type.String({
    description: "Optional absolute working directory for this subagent. Resolved with realpath and must be an existing directory.",
  })),
});

const SUBAGENT_JOB_PARAMETERS = Type.Object({
  action: StringEnum(["status", "wait", "cancel", "list"] as const, {
    description: "Inspect, wait for, cancel, or list asynchronous subagent jobs.",
  }),
  job_id: Type.Optional(Type.String({ description: "Job ID (required except for list)." })),
});

type SubagentStartParams = Static<typeof SUBAGENT_PARAMETERS>;
type SubagentJobParams = Static<typeof SUBAGENT_JOB_PARAMETERS>;

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Extension tool registration ──────────────────────────────────────────
  // The shared registry's atomic registration keeps a tool and its capabilities
  // inseparable through discovery, resolution, and execution.
  const registeredExtTools = new Map<string, ExtToolRegistration>();
  listenForAgentTools(pi, (registration) => {
    registeredExtTools.set(registration.tool.name, registration);
  });

  // Named execute function — stable reference (no recreation on re-register)
  const executeSubagent = createExecuteSubagent(registeredExtTools);
  let jobs: SubagentJobManager | undefined;
  let sessionState: "inactive" | "active" | "shutting-down" = "inactive";
  let lifecycleGeneration = 0;
  const registerSubagentTool = (description: string) => pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description,
    parameters: SUBAGENT_PARAMETERS,
    execute: executeSubagent,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  });
  const executeAsyncSubagent = async (_id: string, params: SubagentStartParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<{ jobId?: string; status: string }>> => {
    if (signal?.aborted) throw new Error("Subagent start aborted.");
    if (sessionState !== "active" || !jobs) {
      return {
        content: [{ type: "text", text: "Cannot start a subagent job without an active parent session." }],
        details: { status: sessionState },
      };
    }
    const manager = jobs;
    const cwd = resolveEffectiveCwd(params as SubagentParams, ctx.cwd);
    if (!isResolutionOk(cwd)) {
      return {
        content: [{ type: "text", text: cwd.error.message }],
        details: { status: cwd.error.reason },
      };
    }
    const normalizedParams = { ...(params as SubagentParams), cwd: cwd.value };
    const job = manager.start(normalizedParams, ctx);
    return {
      content: [{ type: "text", text: `Started subagent job ${job.id} (${job.name}).` }],
      details: { jobId: job.id, status: job.status },
    };
  };
  const executeSubagentJob = async (_id: string, params: SubagentJobParams, signal?: AbortSignal): Promise<AgentToolResult<{ jobId?: string; status?: string }>> => {
    if (params.action === "list") {
      const output = jobs?.list().map(renderJob).join("\n") || "No subagent jobs.";
      return { content: [{ type: "text", text: output }], details: {} };
    }
    if (!params.job_id) throw new Error("job_id is required for status, wait, and cancel.");
    if (params.action === "wait") {
      const manager = jobs;
      if (!manager) throw new Error(`Unknown subagent job: ${params.job_id}`);
      const outcome = await Effect.runPromise(Effect.either(manager.waitEffect(params.job_id, signal)));
      if (Either.isLeft(outcome)) {
        return {
          content: [{ type: "text", text: `Stopped waiting for subagent job ${params.job_id}; it is still running.` }],
          details: { jobId: params.job_id, status: "running" },
        };
      }
      if (!outcome.right) throw new Error(`Unknown subagent job: ${params.job_id}`);
      return { content: [{ type: "text", text: renderJob(outcome.right) }], details: { jobId: outcome.right.id, status: outcome.right.status } };
    }
    const manager = jobs;
    const job = params.action === "cancel" ? manager?.cancel(params.job_id) : manager?.get(params.job_id);
    if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
    return { content: [{ type: "text", text: renderJob(job) }], details: { jobId: job.id, status: job.status } };
  };

  // ── Initial registration (static description) ─────────────────────────────

  registerSubagentTool(STATIC_DESCRIPTION);
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
  pi.on("session_shutdown", async () => {
    const generation = ++lifecycleGeneration;
    sessionState = "shutting-down";
    const manager = jobs;
    jobs = undefined;
    try {
      await manager?.shutdown();
    } finally {
      if (generation === lifecycleGeneration) sessionState = "inactive";
    }
  });

  // ── session_start: re-register with dynamic model + agent list ────────────

  pi.on(PiEvent.SessionStart, async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    sessionState = "shutting-down";
    const old = jobs;
    jobs = undefined;
    if (old) await old.shutdown();
    if (generation !== lifecycleGeneration) return;
    jobs = new SubagentJobManager(pi, registeredExtTools);
    sessionState = "active";
    // 1. Read enabled models and annotations from settings.json
    const settings = readOptionalAgentSettings(undefined, ctx.cwd);
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
    const extToolCaps = new Map(
      [...registeredExtTools].map(([name, registration]) => [name, registration.capabilities]),
    );
    const description = buildDynamicDescription(
      enabledModelIds, availableModels, agents, extToolNames, extToolCaps, modelAnnotations,
    );
    // registerTool replaces this stable name with session-specific discovery text.
    registerSubagentTool(description);
  });
}
