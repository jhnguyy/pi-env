import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { discoverAgents } from "./agents";
import { formatJobToolContent, type SubagentJob } from "./jobs";
import type { SubagentParams } from "./resolver";
import { buildDynamicDescription, STATIC_DESCRIPTION } from "./discovery";
import {
  renderSubagentCall,
  renderSubagentJobCall,
  renderSubagentJobResult,
  renderSubagentResult,
  renderSubagentStartResult,
} from "./render";
import {
  SubagentJobStatus,
  SubagentJobToolStatus,
  type SubagentJobRenderDetails,
} from "./types";
import { SubagentSessionRuntime } from "./session-runtime";
import { listenForAgentTools, PiEvent, type ExtToolRegistration } from "../_shared/agent-tools";
import { readOptionalAgentSettings } from "../_shared/agent-settings";

const SUBAGENT_PARAMETERS = Type.Object({
  name: Type.String({
    description:
      "Required human-readable child-session name. Stored as a `sub-` prefixed session name.",
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
      description:
        "Optional maximum completed assistant turns. Omit to run without a turn-count limit.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Optional absolute working directory for this subagent. Resolved with realpath and must be an existing directory.",
    }),
  ),
});

const SubagentJobAction = {
  Status: "status",
  Wait: "wait",
  Cancel: "cancel",
  List: "list",
  Usage: "usage",
} as const;
type SubagentJobAction = (typeof SubagentJobAction)[keyof typeof SubagentJobAction];

const SUBAGENT_JOB_PARAMETERS = Type.Object({
  action: StringEnum(
    Object.values(SubagentJobAction) as [SubagentJobAction, ...SubagentJobAction[]],
    {
      description: "Inspect, wait for, cancel, list, or summarize asynchronous subagent jobs.",
    },
  ),
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

export default function (pi: ExtensionAPI) {
  const registeredExtTools = new Map<string, ExtToolRegistration>();
  listenForAgentTools(pi, (registration) => {
    registeredExtTools.set(registration.tool.name, registration);
  });

  const runtime = new SubagentSessionRuntime(pi, registeredExtTools);

  const registerSubagentTool = (description: string) =>
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description,
      parameters: SUBAGENT_PARAMETERS,
      execute: runtime.execute,
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
    });
  const executeAsyncSubagent = async (
    _id: string,
    params: SubagentStartParams,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentJobRenderDetails>> => {
    if (signal?.aborted) throw new Error("Subagent start aborted.");
    return runtime.startJob(params as SubagentParams, ctx);
  };
  const executeSubagentJob = async (
    _id: string,
    params: SubagentJobParams,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<SubagentJobRenderDetails>> => {
    if (params.action === SubagentJobAction.Usage) {
      return {
        content: [{ type: "text", text: runtime.usageText() }],
        details: { status: SubagentJobToolStatus.Usage },
      };
    }
    if (params.action === SubagentJobAction.List) {
      const activeJobs = runtime.listJobs();
      const output = activeJobs.map(formatJobToolContent).join("\n") || "No subagent jobs.";
      return {
        content: [{ type: "text", text: output }],
        details: { status: SubagentJobToolStatus.List, count: activeJobs.length },
      };
    }
    if (!params.job_id) throw new Error("job_id is required for status, wait, and cancel.");
    if (params.action === SubagentJobAction.Wait) {
      const waited = await runtime.waitJob(params.job_id, signal);
      if (waited.interrupted) {
        return {
          content: [
            {
              type: "text",
              text: `Stopped waiting for subagent job ${params.job_id}; it is still running.`,
            },
          ],
          details: waited.job
            ? getJobRenderDetails(waited.job)
            : { jobId: params.job_id, status: SubagentJobStatus.Running },
        };
      }
      if (!waited.job) throw new Error(`Unknown subagent job: ${params.job_id}`);
      return {
        content: [{ type: "text", text: formatJobToolContent(waited.job) }],
        details: getJobRenderDetails(waited.job),
      };
    }
    const job =
      params.action === SubagentJobAction.Cancel
        ? runtime.cancelJob(params.job_id)
        : runtime.getJob(params.job_id);
    if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
    return {
      content: [{ type: "text", text: formatJobToolContent(job) }],
      details: getJobRenderDetails(job),
    };
  };

  registerSubagentTool(STATIC_DESCRIPTION);
  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description:
      "Start a named persistent subagent without waiting. Use subagent_job to inspect, wait for, or cancel it. Jobs stop when the parent session shuts down.",
    parameters: SUBAGENT_PARAMETERS,
    execute: executeAsyncSubagent,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentStartResult,
  });
  pi.registerTool({
    name: "subagent_job",
    label: "Subagent Job",
    description:
      "Inspect, wait for, cancel, list, or summarize in-process asynchronous subagent jobs.",
    parameters: SUBAGENT_JOB_PARAMETERS,
    execute: executeSubagentJob,
    renderCall: renderSubagentJobCall,
    renderResult: renderSubagentJobResult,
  });
  pi.on("session_shutdown", async () => runtime.shutdownSession());

  pi.on(PiEvent.SessionStart, async (_event, ctx) => {
    if (!(await runtime.startSession())) return;
    const settings = readOptionalAgentSettings(undefined, ctx.cwd);
    const enabledModelIds = Array.isArray(settings?.enabledModels) ? settings.enabledModels : [];
    const modelAnnotations = settings?.modelAnnotations ?? {};

    const availableModels = ctx.modelRegistry.getAvailable() as Array<{
      provider: string;
      id: string;
      name: string;
    }>;

    const { agents } = discoverAgents(ctx.cwd, "both");

    const extToolNames = [...registeredExtTools.keys()];
    const extToolCaps = new Map(
      [...registeredExtTools].map(([name, registration]) => [name, registration.capabilities]),
    );
    const description = buildDynamicDescription(
      enabledModelIds,
      availableModels,
      agents,
      extToolNames,
      extToolCaps,
      modelAnnotations,
    );
    registerSubagentTool(description);
  });
}
