import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { discoverAgents } from "./agents";
import { formatJobMetadata, formatJobResult, type SubagentJob } from "./jobs";
import type { SubagentParams } from "./resolver";
import { buildDynamicDescription, STATIC_DESCRIPTION } from "./discovery";
import {
  renderSubagentCall,
  renderSubagentJobCall,
  renderSubagentJobResult,
  renderSubagentResult,
  renderSubagentStartResult,
} from "./render";
import { SubagentJobStatus, SubagentJobToolStatus, type SubagentJobRenderDetails } from "./types";
import { SubagentSessionRuntime } from "./session-runtime";
import { toNestedToolUsage } from "./usage";
import { listenForAgentTools, PiEvent, type ExtToolRegistration } from "../_shared/agent-tools";
import { readOptionalAgentSettings } from "../_shared/agent-settings";
export {
  DagSubagentAdapterFailure,
  DagSubagentExecutorKey,
  makeDagSubagentExecutorRegistry,
  makeDagSubagentRuntime,
} from "./dag-runtime";

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
  agent_scope: Type.Optional(
    StringEnum(["user", "project"] as const, {
      description:
        "Agent definition scope. Defaults to user and installed package agents. Project agents require explicit scope and project trust.",
    }),
  ),
});

const SubagentJobAction = {
  Status: "status",
  Wait: "wait",
  Cancel: "cancel",
  List: "list",
  Usage: "usage",
  Result: "result",
} as const;
type SubagentJobAction = (typeof SubagentJobAction)[keyof typeof SubagentJobAction];

const SUBAGENT_JOB_PARAMETERS = Type.Object({
  action: StringEnum(
    Object.values(SubagentJobAction) as [SubagentJobAction, ...SubagentJobAction[]],
    {
      description:
        "Inspect, wait for, cancel, list, retrieve a bounded result, or summarize asynchronous subagent jobs.",
    },
  ),
  job_id: Type.Optional(Type.String({ description: "Job ID (required except for list/usage)." })),
});

type SubagentStartParams = Static<typeof SUBAGENT_PARAMETERS>;
type SubagentJobParams = Static<typeof SUBAGENT_JOB_PARAMETERS>;

export function completedJobUsageOnce(
  reportedJobUsage: Set<string>,
  job: SubagentJob,
) {
  if (
    job.status === SubagentJobStatus.Queued ||
    job.status === SubagentJobStatus.Running ||
    job.status === SubagentJobStatus.Cancelling ||
    reportedJobUsage.has(job.id) ||
    !job.latestDetails?.usage
  )
    return {};
  reportedJobUsage.add(job.id);
  return { usage: toNestedToolUsage(job.latestDetails.usage) };
}

function getJobRenderDetails(job: SubagentJob): SubagentJobRenderDetails {
  const details = job.latestDetails;
  return {
    jobId: job.id,
    status: job.status,
    name: job.name,
    task: job.task,
    toolCallCount: details?.toolCallCount,
    usage: details?.usage,
    model: details?.model,
    sessionName: details?.sessionName,
    sessionFile: details?.sessionFile,
    resultTruncated: job.resultTruncated,
  };
}

export default function (pi: ExtensionAPI) {
  const registeredExtTools = new Map<string, ExtToolRegistration>();
  const stopListeningForAgentTools = listenForAgentTools(
    pi,
    (registration) => {
      registeredExtTools.set(registration.tool.name, registration);
    },
    (registration) => {
      if (registeredExtTools.get(registration.tool.name) === registration) {
        registeredExtTools.delete(registration.tool.name);
      }
    },
  );

  const runtime = new SubagentSessionRuntime(pi, registeredExtTools);
  const reportedJobUsage = new Set<string>();

  const registerSubagentTool = (description: string) =>
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description,
      parameters: SUBAGENT_PARAMETERS,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const result = await runtime.execute(toolCallId, params, signal, onUpdate, ctx);
        return { ...result, usage: toNestedToolUsage(result.details.usage) };
      },
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
    return runtime.startJob(params, ctx, signal);
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
      const output = activeJobs.map(formatJobMetadata).join("\n") || "No subagent jobs.";
      return {
        content: [{ type: "text", text: output }],
        details: { status: SubagentJobToolStatus.List, count: activeJobs.length },
      };
    }
    if (!params.job_id) throw new Error("job_id is required for status, wait, result, and cancel.");
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
        content: [{ type: "text", text: formatJobResult(waited.job) }],
        details: getJobRenderDetails(waited.job),
        ...completedJobUsageOnce(reportedJobUsage, waited.job),
      };
    }
    if (params.action === SubagentJobAction.Result) {
      const job = runtime.getJob(params.job_id);
      if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
      return {
        content: [{ type: "text", text: formatJobResult(job) }],
        details: getJobRenderDetails(job),
        ...completedJobUsageOnce(reportedJobUsage, job),
      };
    }
    const job =
      params.action === SubagentJobAction.Cancel
        ? runtime.cancelJob(params.job_id)
        : runtime.getJob(params.job_id);
    if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
    return {
      content: [{ type: "text", text: formatJobMetadata(job) }],
      details: getJobRenderDetails(job),
    };
  };

  registerSubagentTool(STATIC_DESCRIPTION);
  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description:
      "Start a session-scoped subagent job without waiting. The live job handle is volatile. The linked child transcript persists. Use subagent_job to inspect, wait, retrieve a bounded result, or cancel the job.",
    parameters: SUBAGENT_PARAMETERS,
    execute: executeAsyncSubagent,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentStartResult,
  });
  pi.registerTool({
    name: "subagent_job",
    label: "Subagent Job",
    description:
      "Inspect, wait for, cancel, list, retrieve bounded results, or summarize session-scoped asynchronous subagent jobs.",
    parameters: SUBAGENT_JOB_PARAMETERS,
    execute: executeSubagentJob,
    renderCall: renderSubagentJobCall,
    renderResult: renderSubagentJobResult,
  });
  pi.on(PiEvent.SessionBeforeTree, async () => {
    await runtime.settleJobsBeforeTreeNavigation();
  });
  pi.on("session_shutdown", async () => {
    stopListeningForAgentTools();
    await runtime.shutdownSession();
  });

  pi.on(PiEvent.SessionStart, async (_event, ctx) => {
    if (!(await runtime.startSession(ctx))) return;
    const settings = readOptionalAgentSettings(undefined, ctx.cwd);
    const enabledModelIds = Array.isArray(settings?.enabledModels) ? settings.enabledModels : [];
    const modelAnnotations = settings?.modelAnnotations ?? {};
    const availableModels = ctx.modelRegistry.getAvailable() as Array<{
      provider: string;
      id: string;
      name: string;
    }>;

    const { agents } = discoverAgents(ctx.cwd, "user");

    const publicExtTools = [...registeredExtTools].filter(
      ([, registration]) => registration.audience !== "dag",
    );
    const extToolNames = publicExtTools.map(([name]) => name);
    const extToolCaps = new Map(
      publicExtTools.map(([name, registration]) => [name, registration.capabilities]),
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
