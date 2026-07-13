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
import { Effect, Result } from "effect";
import { Type, type Static } from "typebox";

import { discoverAgents } from "./agents";
import { createExecuteSubagent } from "./execute";
import { formatJobToolContent, type SubagentJob, SubagentJobManager } from "./jobs";
import { isResolutionOk, resolveEffectiveCwd, type SubagentParams } from "./resolver";
import { buildDynamicDescription, STATIC_DESCRIPTION } from "./discovery";
import {
  renderSubagentCall,
  renderSubagentJobCall,
  renderSubagentJobResult,
  renderSubagentResult,
  renderSubagentStartResult,
} from "./render";
import type { SubagentJobRenderDetails } from "./types";
import { SubagentUsageLedger } from "./usage";
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

const SubagentSessionState = {
  Inactive: "inactive",
  Active: "active",
  ShuttingDown: "shutting-down",
} as const;
type SubagentSessionState = typeof SubagentSessionState[keyof typeof SubagentSessionState];

const SubagentJobAction = {
  Status: "status",
  Wait: "wait",
  Cancel: "cancel",
  List: "list",
  Usage: "usage",
} as const;
type SubagentJobAction = typeof SubagentJobAction[keyof typeof SubagentJobAction];

const SUBAGENT_JOB_PARAMETERS = Type.Object({
  action: StringEnum(Object.values(SubagentJobAction) as [SubagentJobAction, ...SubagentJobAction[]], {
    description: "Inspect, wait for, cancel, list, or summarize asynchronous subagent jobs.",
  }),
  job_id: Type.Optional(Type.String({ description: "Job ID (required except for list/usage)." })),
});

type SubagentStartParams = Static<typeof SUBAGENT_PARAMETERS>;
type SubagentJobParams = Static<typeof SUBAGENT_JOB_PARAMETERS>;

function getJobRenderDetails(job: SubagentJob): SubagentJobRenderDetails {
  const details = job.latestDetails ?? job.result?.details;
  return {
    jobId: job.id,
    status: job.status,
    name: job.name,
    task: job.params.task,
    toolCallCount: details?.toolCallCount,
    usage: details?.usage,
    model: details?.model,
    sessionName: details?.sessionName,
  };
}

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
  const ledger = new SubagentUsageLedger();
  const executeSubagent = createExecuteSubagent(registeredExtTools, ledger);
  let jobs: SubagentJobManager | undefined;
  let sessionState: SubagentSessionState = SubagentSessionState.Inactive;
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
  const executeAsyncSubagent = async (_id: string, params: SubagentStartParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<SubagentJobRenderDetails>> => {
    if (signal?.aborted) throw new Error("Subagent start aborted.");
    if (sessionState !== SubagentSessionState.Active || !jobs) {
      return {
        content: [{ type: "text", text: "Cannot start a subagent job without an active parent session." }],
        details: { status: sessionState, name: params.name, task: params.task },
      };
    }
    const manager = jobs;
    const cwd = resolveEffectiveCwd(params as SubagentParams, ctx.cwd);
    if (!isResolutionOk(cwd)) {
      return {
        content: [{ type: "text", text: cwd.error.message }],
        details: { status: cwd.error.reason, name: params.name, task: params.task },
      };
    }
    const normalizedParams = { ...(params as SubagentParams), cwd: cwd.value };
    const job = manager.start(normalizedParams, ctx);
    return {
      content: [{ type: "text", text: `Started subagent job ${job.id} (${job.name}).` }],
      details: { jobId: job.id, status: job.status, name: job.name, task: params.task },
    };
  };
  const executeSubagentJob = async (_id: string, params: SubagentJobParams, signal?: AbortSignal): Promise<AgentToolResult<SubagentJobRenderDetails>> => {
    if (params.action === SubagentJobAction.Usage) {
      return {
        content: [{ type: "text", text: ledger.render() }],
        details: { status: "usage" },
      };
    }
    if (params.action === SubagentJobAction.List) {
      const activeJobs = jobs?.list() ?? [];
      const output = activeJobs.map(formatJobToolContent).join("\n") || "No subagent jobs.";
      return {
        content: [{ type: "text", text: output }],
        details: { status: "list", count: activeJobs.length },
      };
    }
    if (!params.job_id) throw new Error("job_id is required for status, wait, and cancel.");
    if (params.action === SubagentJobAction.Wait) {
      const manager = jobs;
      if (!manager) throw new Error(`Unknown subagent job: ${params.job_id}`);
      const outcome = await Effect.runPromise(Effect.result(manager.waitEffect(params.job_id, signal)));
      if (Result.isFailure(outcome)) {
        const runningJob = manager.get(params.job_id);
        return {
          content: [{ type: "text", text: `Stopped waiting for subagent job ${params.job_id}; it is still running.` }],
          details: runningJob
            ? getJobRenderDetails(runningJob)
            : { jobId: params.job_id, status: "running" },
        };
      }
      if (!outcome.success) throw new Error(`Unknown subagent job: ${params.job_id}`);
      return {
        content: [{ type: "text", text: formatJobToolContent(outcome.success) }],
        details: getJobRenderDetails(outcome.success),
      };
    }
    const manager = jobs;
    const job = params.action === SubagentJobAction.Cancel ? manager?.cancel(params.job_id) : manager?.get(params.job_id);
    if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
    return {
      content: [{ type: "text", text: formatJobToolContent(job) }],
      details: getJobRenderDetails(job),
    };
  };

  // ── Initial registration (static description) ─────────────────────────────

  registerSubagentTool(STATIC_DESCRIPTION);
  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start a named persistent subagent without waiting. Use subagent_job to inspect, wait for, or cancel it. Jobs stop when the parent session shuts down.",
    parameters: SUBAGENT_PARAMETERS,
    execute: executeAsyncSubagent,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentStartResult,
  });
  pi.registerTool({
    name: "subagent_job",
    label: "Subagent Job",
    description: "Inspect, wait for, cancel, list, or summarize in-process asynchronous subagent jobs.",
    parameters: SUBAGENT_JOB_PARAMETERS,
    execute: executeSubagentJob,
    renderCall: renderSubagentJobCall,
    renderResult: renderSubagentJobResult,
  });
  pi.on("session_shutdown", async () => {
    const generation = ++lifecycleGeneration;
    sessionState = SubagentSessionState.ShuttingDown;
    const manager = jobs;
    jobs = undefined;
    try {
      await manager?.shutdown();
    } finally {
      if (generation === lifecycleGeneration) {
        ledger.clear();
        sessionState = SubagentSessionState.Inactive;
      }
    }
  });

  // ── session_start: re-register with dynamic model + agent list ────────────

  pi.on(PiEvent.SessionStart, async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    sessionState = SubagentSessionState.ShuttingDown;
    const old = jobs;
    jobs = undefined;
    if (old) await old.shutdown();
    if (generation !== lifecycleGeneration) return;
    ledger.clear();
    jobs = new SubagentJobManager(pi, registeredExtTools, undefined, ledger);
    sessionState = SubagentSessionState.Active;
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
