import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { OverlayHandle } from "@earendil-works/pi-tui";

import * as Browser from "./browser";
import * as ChildTypes from "./child-types";
import * as Jobs from "./jobs";
import type * as Resolver from "./resolver";
import * as Discovery from "./discovery";
import * as Render from "./render";
import * as Types from "./types";
import * as SessionRuntime from "./session-runtime";
import * as NativeUsage from "../_shared/native-usage";
import * as AgentTools from "../_shared/agent-tools";
import * as ChildContext from "../_shared/child-context";
import * as Transcript from "./transcript";
import * as AgentSettings from "../_shared/agent-settings";
import * as ToolRender from "../_shared/tool-render";
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
        "run waits for the initial answer. start returns a background job ID. list shows retained jobs. usage totals child usage.",
    }),
    name: Type.Optional(
      Type.String({
        description:
          "Child-session label. Required for run/start.",
      }),
    ),
    task: Type.Optional(Type.String({ description: "Task to delegate. Required for run/start." })),
    tools: Type.Optional(
      Type.Array(Type.String(), {
        description: "Child tool names. Omit for child defaults. [] selects none.",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description:
          "provider/model-id for run/start. Omit for the child default.",
      }),
    ),
    system_prompt: Type.Optional(
      Type.String({
        description:
          "Additional child instructions. Native context still loads.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Existing absolute working directory for run/start. Defaults to the parent cwd.",
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

function requireRunParams(params: SubagentToolParams): Resolver.SubagentParams {
  if (!params.name) throw new Error(`name is required for subagent ${params.action}.`);
  if (!params.task) throw new Error(`task is required for subagent ${params.action}.`);
  return {
    name: params.name,
    task: params.task,
    tools: params.tools,
    model: params.model,
    system_prompt: params.system_prompt,
    cwd: params.cwd,
  };
}

function completedJobUsageOnce(reportedJobUsage: Set<string>, job: Jobs.SubagentJob) {
  if (
    job.status === Types.SubagentJobStatus.Queued ||
    job.status === Types.SubagentJobStatus.Running ||
    job.status === Types.SubagentJobStatus.Cancelling ||
    reportedJobUsage.has(job.id) ||
    !job.latestDetails?.usage
  )
    return {};
  reportedJobUsage.add(job.id);
  return { usage: NativeUsage.toNestedToolUsage(job.latestDetails.usage) };
}

function getJobRenderDetails(job: Jobs.SubagentJob): Types.SubagentJobRenderDetails {
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

function inputOutcomeFeedback(outcome: ChildTypes.NativeInputOutcome, mode: ChildTypes.NativeInputMode): string {
  switch (outcome) {
    case ChildTypes.NativeInputOutcome.Queued:
      return `${mode === ChildTypes.NativeInputMode.Steer ? "Steering" : "Follow-up"} queued for native processing.`;
    case ChildTypes.NativeInputOutcome.Handled:
      return "Handled by a child input hook; no model turn started.";
    case ChildTypes.NativeInputOutcome.Started:
      return "Native prompt settled.";
  }
}

export default function (pi: ExtensionAPI, dependencies: SessionRuntime.SubagentSessionRuntimeDependencies = {}) {
  if (ChildContext.getChildContext()) return;
  const runtime = new SessionRuntime.SubagentSessionRuntime(pi, dependencies);
  const reportedJobUsage = new Set<string>();
  const browser: { current?: Browser.SubagentBrowser } = {};
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
          let component: Browser.SubagentBrowser;
          component = new Browser.SubagentBrowser(runtime, tui, theme, () => done(), async (id, mode) => {
            if (composing || browser.current !== component) return;
            const child = runtime.inspectChild(id);
            if (!child) throw new Error("Child session is no longer retained.");
            const key = `${id}:${mode}`;
            const name = Transcript.plainChildText(child.name).replace(/\s+/g, " ").trim();
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
              const feedback = inputOutcomeFeedback(outcome, mode);
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
  ): Promise<AgentToolResult<Types.SubagentJobRenderDetails>> => {
    if (params.action === SubagentAction.Usage) {
      return {
        content: [{ type: "text", text: runtime.usageText() }],
        details: { status: Types.SubagentJobToolStatus.Usage },
      };
    }
    if (params.action === SubagentAction.List) {
      const activeJobs = runtime.listJobs();
      const output = activeJobs.map(Jobs.formatJobMetadata).join("\n") || "No subagent jobs.";
      return {
        content: [{ type: "text", text: output }],
        details: { status: Types.SubagentJobToolStatus.List, count: activeJobs.length },
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
            : { jobId: params.job_id, status: Types.SubagentJobStatus.Running },
        };
      }
      if (!waited.job) throw new Error(`Unknown subagent job: ${params.job_id}`);
      return {
        content: [{ type: "text", text: Jobs.formatJobResult(waited.job) }],
        details: getJobRenderDetails(waited.job),
        ...completedJobUsageOnce(reportedJobUsage, waited.job),
      };
    }
    if (params.action === SubagentAction.Result) {
      const job = runtime.getJob(params.job_id);
      if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
      return {
        content: [{ type: "text", text: Jobs.formatJobResult(job) }],
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
      content: [{ type: "text", text: Jobs.formatJobMetadata(job) }],
      details: getJobRenderDetails(job),
    };
  };

  const registerSubagentTool = (description: string) =>
    ToolRender.registerPublicTool(pi, {
      name: "subagent",
      label: "Subagent",
      description,
      parameters: SUBAGENT_PARAMETERS,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        // Direct extension callers must not silently discard obsolete instructions.
        if (Object.hasOwn(params, "agent") || Object.hasOwn(params, "agent_scope")) {
          throw new Error("Named agent definitions are no longer supported. Use explicit model, tools, and system_prompt overrides.");
        }
        if (params.action === SubagentAction.Run) {
          const result = await runtime.execute(
            toolCallId,
            requireRunParams(params),
            signal,
            onUpdate,
            ctx,
          );
          return { ...result, usage: NativeUsage.toNestedToolUsage(result.details.usage) };
        }
        if (params.action === SubagentAction.Start) {
          if (signal?.aborted) throw new Error("Subagent start aborted.");
          return runtime.startJob(requireRunParams(params), ctx, signal);
        }
        return executeJobAction(params, signal);
      },
      renderCall: (args, theme, context) =>
        Render.renderSubagentToolCall(
          args,
          theme,
          context,
          args.action === SubagentAction.Wait && args.job_id
            ? runtime.getJob(args.job_id)?.name
            : undefined,
        ),
      renderResult: Render.renderSubagentToolResult,
    });

  registerSubagentTool(Discovery.STATIC_DESCRIPTION);
  pi.on(AgentTools.PiEvent.SessionBeforeTree, async () => {
    await runtime.settleJobsBeforeTreeNavigation();
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    browser.current?.close();
    await runtime.shutdownSession(ctx);
  });

  pi.on(AgentTools.PiEvent.SessionStart, async (_event, ctx) => {
    if (!(await runtime.startSession(ctx))) return;
    const settings = AgentSettings.readOptionalAgentSettings(undefined, ctx.cwd);
    const modelAnnotations = settings?.modelAnnotations ?? {};
    const scoped = ctx.scopedModels.length > 0;
    const models = scoped ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
    const description = Discovery.buildDynamicDescription(
      models,
      modelAnnotations,
    );
    registerSubagentTool(description);
  });
}
