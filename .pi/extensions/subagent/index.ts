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
  Input: "input",
  Inspect: "inspect",
  Reopen: "reopen",
} as const;
export type SubagentAction = (typeof SubagentAction)[keyof typeof SubagentAction];

const SUBAGENT_PARAMETERS = Type.Object(
  {
    action: StringEnum(Object.values(SubagentAction) as [SubagentAction, ...SubagentAction[]], {
      description:
        "run waits for the initial answer; start returns a durable job ID. status/list return metadata only. wait/result page an operation's stored answer. input/inspect/reopen target child_id. usage totals child usage.",
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
    child_id: Type.Optional(Type.String({ description: "Child ID from job metadata. Required for input, inspect, and reopen." })),
    text: Type.Optional(Type.String({ minLength: 1, description: "Coordinator input text. Required for input; native input hooks still apply." })),
    mode: Type.Optional(StringEnum(Object.values(ChildTypes.NativeInputMode), { description: "Required for input. prompt requires idle; steer/followUp require running. Historical children require explicit reopen first." })),
    view: Type.Optional(StringEnum([...Browser.VIEWS], { description: "Select one inspect view (default conversation). Conversation shows bounded native context; sessionFile retains history." })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-16 character offset for result, wait, or inspect (default 0)." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, description: "Maximum output characters for result, wait, or inspect (default 4096, max 16384)." })),
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

function pageOptions(params: SubagentToolParams): { offset: number; limit: number } {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 4096;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative safe integer.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw new Error("limit must be an integer from 1 to 16384.");
  return { offset, limit };
}

function pageText(page: { text: string; offset: number; nextOffset: number | null; total: number }): string {
  return `${page.text}\n\n[characters ${page.offset}-${page.offset + page.text.length}/${page.total}${page.nextOffset === null ? "" : `; next offset=${page.nextOffset}`} ]`;
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
    childId: job.childId,
    status: job.status,
    name: job.name,
    task: job.task,
    toolCallCount: details?.toolCallCount,
    usage: details?.usage,
    model: details?.model,
    sessionName: details?.sessionName,
    sessionFile: job.sessionFile ?? details?.sessionFile,
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
            const child = runtime.listChildren().find((entry) => entry.id === id);
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
            void Promise.resolve().then(() => runtime.inputChild(id, submitted, mode)).then(({ outcome, cancelled }) => {
              if (drafts.get(key) === submitted) drafts.delete(key);
              const feedback = cancelled ? "cancellation settled." : inputOutcomeFeedback(outcome, mode);
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

  const inspectChildAction = async (id: string, params: SubagentToolParams): Promise<AgentToolResult<Types.SubagentJobRenderDetails>> => {
    const { offset, limit } = pageOptions(params);
    const child = await runtime.inspectChild(id);
    if (!child) return { content: [{ type: "text", text: `${id}: no live inspection available. Use reopen explicitly for a historical child; reopening never replays inputs.` }], details: {} };
    const view = params.view ?? "conversation";
    const text = Transcript.plainChildText(Browser.childViewText(child, view));
    const start = Math.min(offset, text.length);
    const end = Math.min(start + limit, text.length);
    return {
      content: [{ type: "text", text: `${id} · ${view}\n${pageText({ text: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null, total: text.length })}` }],
      details: { name: child.name, sessionFile: child.sessionFile, resultTruncated: end < text.length },
    };
  };

  const executeChildAction = async (params: SubagentToolParams): Promise<AgentToolResult<Types.SubagentJobRenderDetails>> => {
    if (!params.child_id) throw new Error(`child_id is required for subagent ${params.action}.`);
    const id = params.child_id;
    if (params.action === SubagentAction.Input) {
      if (!params.text || !params.mode) throw new Error("text and mode are required for subagent input.");
      const input = await runtime.inputChild(id, params.text, params.mode, "coordinator");
      const feedback = input.cancelled ? "cancellation settled." : inputOutcomeFeedback(input.outcome, params.mode);
      const answer = params.mode === "prompt" && input.result.total > 0 ? `\n${pageText(input.result)}` : "";
      return {
        content: [{ type: "text", text: `${id}: ${feedback}\nOperation: ${input.operationId}${answer}` }],
        details: { jobId: input.operationId, childId: id, resultTruncated: input.result.truncated },
      };
    }
    if (params.action === SubagentAction.Reopen) {
      await runtime.reopenChild(id);
      return { content: [{ type: "text", text: `${id}: child reopened without replaying inputs.` }], details: {} };
    }
    return inspectChildAction(id, params);
  };

  const resultResponse = async (job: Jobs.SubagentJob, options: ReturnType<typeof pageOptions>): Promise<AgentToolResult<Types.SubagentJobRenderDetails>> => {
    const page = job.status === Types.SubagentJobStatus.Completed ? await runtime.resultJob(job.id, options) : undefined;
    return {
      content: [{ type: "text", text: page ? pageText(page) : Jobs.formatJobMetadata(job) }],
      details: { ...getJobRenderDetails(job), resultTruncated: page?.truncated },
      ...completedJobUsageOnce(reportedJobUsage, job),
    };
  };

  const waitJobAction = async (jobId: string, params: SubagentToolParams, signal?: AbortSignal): Promise<AgentToolResult<Types.SubagentJobRenderDetails>> => {
    const options = pageOptions(params);
    const waited = await runtime.waitJob(jobId, signal);
    if (waited.interrupted) return {
      content: [{ type: "text", text: `Stopped waiting for subagent job ${jobId}; it is still running.` }],
      details: waited.job ? getJobRenderDetails(waited.job) : { jobId, status: Types.SubagentJobStatus.Running },
    };
    if (!waited.job) throw new Error(`Unknown subagent job: ${jobId}`);
    return resultResponse(waited.job, options);
  };

  const childActions = new Set<SubagentAction>([SubagentAction.Input, SubagentAction.Inspect, SubagentAction.Reopen]);
  const executeJobAction = async (params: SubagentToolParams, signal?: AbortSignal): Promise<AgentToolResult<Types.SubagentJobRenderDetails>> => {
    if (runtime.state === Types.SubagentSessionState.Active) runtime.assertConnected();
    if (childActions.has(params.action)) return executeChildAction(params);
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
    if (params.action === SubagentAction.Wait) return waitJobAction(params.job_id, params, signal);
    const job =
      params.action === SubagentAction.Cancel
        ? await runtime.cancelJob(params.job_id)
        : runtime.getJob(params.job_id);
    if (!job) throw new Error(`Unknown subagent job: ${params.job_id}`);
    if (params.action === SubagentAction.Result) return resultResponse(job, pageOptions(params));
    return {
      content: [{ type: "text", text: Jobs.formatJobMetadata(job) }],
      details: getJobRenderDetails(job),
    };
  };

  const registerSubagentTool = (description: string) =>
    ToolRender.registerPublicTool(pi, {
      name: "subagent",
      label: "Subagent",
      description: `${description}\nUse input with child_id, text, and mode to continue a child as coordinator; queued steering/follow-up acknowledges delivery, not model consumption. inspect selects one bounded view. Historical owners require explicit reopen, which never replays work. status/list contain metadata only; input returns its operation ID and bounded prompt answer; result and wait page stored operation answers with optional offset/limit (4096 characters by default, max 16384).`,
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
          if (result.details.jobId) reportedJobUsage.add(result.details.jobId);
          return { ...result, usage: NativeUsage.toNestedToolUsage(result.details.usage) };
        }
        if (params.action === SubagentAction.Start) {
          if (signal?.aborted) throw new Error("Subagent start aborted.");
          return runtime.startJob(requireRunParams(params), ctx, signal, toolCallId);
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
