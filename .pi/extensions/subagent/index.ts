import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { OverlayHandle } from "@earendil-works/pi-tui";

import { discoverAgents } from "./agents";
import { SubagentBrowser } from "./browser";
import { formatJobMetadata, formatJobResult, type SubagentJob } from "./jobs";
import type { SubagentParams } from "./resolver";
import { buildDynamicDescription, STATIC_DESCRIPTION } from "./discovery";
import { renderSubagentToolCall, renderSubagentToolResult } from "./render";
import { SubagentJobStatus, SubagentJobToolStatus, type SubagentJobRenderDetails } from "./types";
import { SubagentSessionRuntime, type SubagentSessionRuntimeDependencies } from "./session-runtime";
import { toNestedToolUsage } from "./usage";
import { PiEvent } from "../_shared/agent-tools";
import { getChildContext } from "../_shared/child-context";
import { plainChildText } from "./transcript";
import { readOptionalAgentSettings } from "../_shared/agent-settings";
import { registerPublicTool } from "../_shared/tool-render";
export {
  DagSubagentAdapterFailure,
  DagSubagentExecutorKey,
  createDagSubagentExecutorRegistry,
  makeDagSubagentRuntime,
} from "./dag-runtime";

export const SubagentAction = {
  Run: "run",
  Start: "start",
  Status: "status",
  Wait: "wait",
  Cancel: "cancel",
  List: "list",
  Usage: "usage",
  Result: "result",
} as const;
export type SubagentAction = (typeof SubagentAction)[keyof typeof SubagentAction];

const SUBAGENT_PARAMETERS = Type.Object(
  {
    action: StringEnum(Object.values(SubagentAction) as [SubagentAction, ...SubagentAction[]], {
      description:
        "Operation to perform. Use run for a blocking child, start for a background child, or a job-management action.",
    }),
    name: Type.Optional(
      Type.String({
        description:
          "Human-readable child-session name. Required for run/start. Stored as a `sub-` prefixed session name.",
      }),
    ),
    agent: Type.Optional(
      Type.String({
        description:
          "Agent name for run/start. Resolves to an agent definition with tools, model, and system prompt configuration.",
      }),
    ),
    task: Type.Optional(Type.String({ description: "Task to delegate. Required for run/start." })),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description: "Explicit child tool selection. Omit for native defaults; [] selects no tools.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "Model as 'provider/model-id' for run/start. Omit for the child-native default.",
      }),
    ),
    system_prompt: Type.Optional(
      Type.String({
        description:
          "Additional delegated system instructions. Native context and resources still load normally.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Absolute working directory for run/start. Resolved with realpath and must be an existing directory.",
      }),
    ),
    agent_scope: Type.Optional(
      StringEnum(["user", "project"] as const, {
        description:
          "Agent definition scope for run/start. Defaults to user and installed package agents. Project agents require explicit scope and project trust.",
      }),
    ),
    job_id: Type.Optional(
      Type.String({
        description: "Job ID. Required for status, wait, result, and cancel.",
      }),
    ),
  },
  { additionalProperties: false },
);

type SubagentToolParams = Static<typeof SUBAGENT_PARAMETERS>;

function requireRunParams(params: SubagentToolParams): SubagentParams {
  if (!params.name) throw new Error(`name is required for subagent ${params.action}.`);
  if (!params.task) throw new Error(`task is required for subagent ${params.action}.`);
  return {
    name: params.name,
    agent: params.agent,
    task: params.task,
    tools: params.tools,
    model: params.model,
    system_prompt: params.system_prompt,
    cwd: params.cwd,
    agent_scope: params.agent_scope,
  };
}

function completedJobUsageOnce(reportedJobUsage: Set<string>, job: SubagentJob) {
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

export default function (pi: ExtensionAPI, dependencies: SubagentSessionRuntimeDependencies = {}) {
  if (getChildContext()) return;
  const runtime = new SubagentSessionRuntime(pi, dependencies);
  const reportedJobUsage = new Set<string>();
  const browser: { current?: SubagentBrowser } = {};
  const disposeBrowser = () => {
    browser.current?.dispose();
    browser.current = undefined;
  };

  pi.registerCommand("subagents", {
    description: "Inspect and interact with retained native children without switching the parent",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subagents requires interactive terminal mode.", "warning");
        return;
      }
      if (browser.current) return;
      if (runtime.listChildren().length === 0) {
        ctx.ui.notify("No retained child sessions in this parent session.", "info");
        return;
      }
      const drafts = new Map<string, string>();
      let handle: OverlayHandle | undefined;
      let composing = false;
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          let component: SubagentBrowser;
          component = new SubagentBrowser(runtime, tui, theme, () => done(), async (id, mode) => {
            if (composing || browser.current !== component) return;
            const child = runtime.inspectChild(id);
            if (!child) throw new Error("Child session is no longer retained.");
            const key = `${id}:${mode}`;
            const name = plainChildText(child.name).replace(/\s+/g, " ").trim();
            composing = true;
            let text: string | undefined;
            // Native editor dialogs occupy the parent editor container. Hide this overlay
            // while the dialog owns focus; the parent's editor object and draft stay intact.
            handle?.setHidden(true);
            try {
              text = await ctx.ui.editor(`Human → ${name} · ${mode}`, drafts.get(key));
            } finally {
              composing = false;
              if (browser.current === component) handle?.setHidden(false);
            }
            if (text === undefined || browser.current !== component) return;
            drafts.set(key, text);
            component.showStatus(`${name}: submitting ${mode}.`);
            const submitted = text;
            void Promise.resolve().then(() => runtime.inputChild(id, submitted, mode)).then(({ outcome }) => {
              if (drafts.get(key) === submitted) drafts.delete(key);
              const feedback = outcome === "queued" ? `${mode === "steer" ? "Steering" : "Follow-up"} queued for native processing.` : outcome === "handled" ? "Handled by a child input hook; no model turn started." : "Native prompt settled.";
              component.showStatus(`${name}: ${feedback}`);
            }, (error) => component.showStatus(`${name}: ${error instanceof Error ? error.message : String(error)} Draft retained; open the same input mode to retry.`));
          });
          browser.current = component;
          return component;
        }, {
          overlay: true,
          overlayOptions: { width: "90%", maxHeight: "80%" },
          onHandle: (overlay) => { handle = overlay; },
        });
      } finally {
        disposeBrowser();
      }
    },
  });

  const executeJobAction = async (
    params: SubagentToolParams,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<SubagentJobRenderDetails>> => {
    if (params.action === SubagentAction.Usage) {
      return {
        content: [{ type: "text", text: runtime.usageText() }],
        details: { status: SubagentJobToolStatus.Usage },
      };
    }
    if (params.action === SubagentAction.List) {
      const activeJobs = runtime.listJobs();
      const output = activeJobs.map(formatJobMetadata).join("\n") || "No subagent jobs.";
      return {
        content: [{ type: "text", text: output }],
        details: { status: SubagentJobToolStatus.List, count: activeJobs.length },
      };
    }
    if (!params.job_id) throw new Error("job_id is required for status, wait, result, and cancel.");
    if (params.action === SubagentAction.Wait) {
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
    if (params.action === SubagentAction.Result) {
      const job = runtime.getJob(params.job_id);
      if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
      return {
        content: [{ type: "text", text: formatJobResult(job) }],
        details: getJobRenderDetails(job),
        ...completedJobUsageOnce(reportedJobUsage, job),
      };
    }
    const job =
      params.action === SubagentAction.Cancel
        ? runtime.cancelJob(params.job_id)
        : runtime.getJob(params.job_id);
    if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
    return {
      content: [{ type: "text", text: formatJobMetadata(job) }],
      details: getJobRenderDetails(job),
    };
  };

  const registerSubagentTool = (description: string) =>
    registerPublicTool(pi, {
      name: "subagent",
      label: "Subagent",
      exposure: "model-only",
      description,
      parameters: SUBAGENT_PARAMETERS,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        if (params.action === SubagentAction.Run) {
          const result = await runtime.execute(
            toolCallId,
            requireRunParams(params),
            signal,
            onUpdate,
            ctx,
          );
          return { ...result, usage: toNestedToolUsage(result.details.usage) };
        }
        if (params.action === SubagentAction.Start) {
          if (signal?.aborted) throw new Error("Subagent start aborted.");
          return runtime.startJob(requireRunParams(params), ctx, signal);
        }
        return executeJobAction(params, signal);
      },
      renderCall: (args, theme, context) =>
        renderSubagentToolCall(
          args,
          theme,
          context,
          args.action === SubagentAction.Wait && args.job_id
            ? runtime.getJob(args.job_id)?.name
            : undefined,
        ),
      renderResult: renderSubagentToolResult,
    });

  registerSubagentTool(STATIC_DESCRIPTION);
  pi.on(PiEvent.SessionBeforeTree, async () => {
    await runtime.settleJobsBeforeTreeNavigation();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    browser.current?.close();
    await runtime.shutdownSession(ctx);
  });

  pi.on(PiEvent.SessionStart, async (_event, ctx) => {
    if (!(await runtime.startSession(ctx))) return;
    const settings = readOptionalAgentSettings(undefined, ctx.cwd);
    const modelAnnotations = settings?.modelAnnotations ?? {};
    const availableModels = ctx.modelRegistry.getAvailable() as Array<{
      provider: string;
      id: string;
      name: string;
    }>;

    const { agents } = discoverAgents(ctx.cwd, "user");

    const description = buildDynamicDescription(availableModels, agents, pi.getAllTools().map((tool) => tool.name), modelAnnotations);
    registerSubagentTool(description);
  });
}
