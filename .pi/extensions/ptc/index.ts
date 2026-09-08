/**
 * ptc — Programmatic Tool Calling extension for pi-env
 */

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { ToolRegistry } from "./tool-registry";
import { PtcExecutor } from "./executor";
import { formatPtcInspection, type PtcToolCatalog } from "./catalog";
import { BLOCKED_TOOLS, PtcAction } from "./types";
import { registerAgentToolsOnSessionStart, ToolCapability } from "../_shared/agent-tools";
import { toolExpandHint, toolExpandKeyHint } from "../_shared/tool-render";

const DESCRIPTION = [
  "Inspect the current PTC runtime contract or run a TypeScript/JavaScript batch script.",
  "When action is omitted, PTC uses run and requires code. Use inspect after dynamic tool activation or when availability is uncertain.",
  "Canonical calls use tools.read({ ... }) or tools[\"dev-tools\"]({ ... }). Global underscore aliases remain compatible.",
  "Nested tools return Promise<string>. Only selected console.log() output and explicit return values enter model context.",
  "Limits: timeout 120 s, max output 50 KB, max tool calls per run 100.",
  "Blocked tools must be called directly, not inside ptc: " + [...BLOCKED_TOOLS].join(", "),
].join("\n");

const PARAM_DESCRIPTION = [
  "The script body for action=run. Write it as the body of an async function.",
  "Top-level await is supported. Variables declared at the top level persist for the script.",
  "",
  "Use tools.read({ path }) for canonical access.",
  'Use tools["dev-tools"]({ action: "diagnostics", path }) for an exact tool name.',
  "Compatibility aliases such as read(...) and dev_tools(...) remain available.",
  "Each tool accepts one object argument and returns Promise<string>.",
  "",
  "Use return for one final value. Use console.log() for multiple selected values.",
  "Use settle(toolPromise) for an independent call that can fail without stopping the batch.",
].join("\n");

const PTC_PARAMETERS = Type.Object({
  action: Type.Optional(
    StringEnum([PtcAction.Inspect, PtcAction.Run] as const, {
      description: 'Use "inspect" for the current runtime contract. Use "run" to execute code.',
    }),
  ),
  code: Type.Optional(Type.String({ description: PARAM_DESCRIPTION })),
});

type PtcInput = Static<typeof PTC_PARAMETERS>;

interface PtcExecutionRuntime {
  execute(
    code: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionContext,
  ): Promise<string>;
}

interface PtcActionResult {
  readonly output: string;
  readonly details: Record<string, unknown>;
}

export async function executePtcAction(
  input: PtcInput,
  runtime: PtcExecutionRuntime,
  registry: ToolRegistry,
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>,
  ctx?: ExtensionContext,
): Promise<PtcActionResult> {
  const action = input.action ?? PtcAction.Run;
  switch (action) {
    case PtcAction.Inspect: {
      const catalog: PtcToolCatalog = registry.getRuntimeSnapshot(pi).catalog;
      return {
        output: formatPtcInspection(catalog),
        details: { action: PtcAction.Inspect, catalog },
      };
    }
    case PtcAction.Run:
      if (input.code === undefined) throw new Error('PTC action="run" requires code.');
      return {
        output: await runtime.execute(input.code, cwd, signal, onUpdate, ctx),
        details: {},
      };
  }
}

export default function ptcExtension(pi: ExtensionAPI) {
  const registry = new ToolRegistry(pi);
  const executor = new PtcExecutor(pi, registry);

  pi.registerTool({
    name: "ptc",
    label: "Programmatic Tool Calling",
    description: DESCRIPTION,
    promptSnippet:
      "Inspect the runtime tool contract or run a TypeScript batch script without exposing intermediate results",
    promptGuidelines: [
      "Prefer ptc over sequential tool calls when you need the same tool more than twice or want to filter results before they enter context.",
      "Use ptc for aggregation, loops, and conditional branching over nested tool output.",
      "Use ptc action=inspect when tool availability is uncertain, when you need an extension tool, or after tool activation changes.",
      "Avoid ptc for one-off tool calls. The startup overhead is not useful for one call.",
    ],
    parameters: PTC_PARAMETERS,

    async execute(_toolCallId, input, signal, onUpdate, ctx) {
      try {
        const result = await executePtcAction(
          input,
          executor,
          registry,
          pi,
          ctx.cwd,
          signal,
          onUpdate,
          ctx,
        );
        return { content: [txt(result.output || "(no output)")], details: result.details };
      } catch (e: unknown) {
        throw new Error(formatError(e, "ptc"), { cause: e });
      }
    },

    renderCall(args, theme, _ctx) {
      if (args.action === PtcAction.Inspect) {
        return new Text(
          theme.fg("toolTitle", theme.bold("ptc")) + theme.fg("muted", " inspect"),
          0,
          0,
        );
      }
      const lines = (args.code ?? "").split("\n");
      const lineCount = lines.filter((line) => line.trim().length > 0).length;
      const firstCodeLine =
        lines
          .find((line) => {
            const text = line.trim();
            return (
              text.length > 0 &&
              !text.startsWith("//") &&
              !text.startsWith("/*") &&
              !text.startsWith("*")
            );
          })
          ?.trim() ?? "";
      const preview =
        firstCodeLine.length > 72 ? firstCodeLine.substring(0, 72) + "…" : firstCodeLine;
      return new Text(
        theme.fg("toolTitle", theme.bold("ptc")) +
          theme.fg("muted", ` ${lineCount}L`) +
          (preview ? "  " + theme.fg("text", preview) : ""),
        0,
        0,
      );
    },

    renderResult(result, opts, theme, ctx) {
      const first = result.content[0];
      const text = first?.type === "text" ? (first.text ?? "") : "";

      if (ctx.isError) return renderPtcError(text, opts.expanded, theme);
      if (opts.isPartial) return renderPtcPartial(text, ctx, theme);
      return opts.expanded
        ? renderPtcExpandedFinal(text, ctx, theme)
        : renderPtcCollapsedFinal(text, ctx, theme);
    },
  });

  const createPtcAgentTool = (cwd: string): AgentTool<any, any> => ({
    name: "ptc",
    label: "Programmatic Tool Calling",
    description: DESCRIPTION,
    parameters: PTC_PARAMETERS,
    execute: async (_toolCallId, input, signal, onUpdate) => {
      try {
        const result = await executePtcAction(
          input as PtcInput,
          executor,
          registry,
          pi,
          cwd,
          signal,
          onUpdate,
        );
        return { content: [txt(result.output || "(no output)")], details: result.details };
      } catch (e: unknown) {
        throw new Error(formatError(e, "ptc"), { cause: e });
      }
    },
  });
  registerAgentToolsOnSessionStart(pi, (_generation, ctx) => ({
    tool: createPtcAgentTool(ctx.cwd),
    createTool: ({ cwd }) => createPtcAgentTool(cwd),
    capabilities: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute],
  }));
}

interface PtcRenderTheme {
  fg(style: string, text: string): string;
}

interface PtcRenderContext {
  state: Record<string, unknown>;
  args?: { action?: string; code?: string };
}

function renderPtcError(text: string, expanded: boolean | undefined, theme: PtcRenderTheme): Text {
  if (expanded) {
    return new Text(
      theme.fg("error", "✗ ptc failed") + "\n" + theme.fg("error", text || "error"),
      0,
      0,
    );
  }
  const summary = (text.split("\n").find((line) => line.trim().length > 0) ?? "error").slice(
    0,
    120,
  );
  return new Text(theme.fg("error", "✗ ptc ") + theme.fg("error", summary), 0, 0);
}

function renderPtcPartial(text: string, ctx: PtcRenderContext, theme: PtcRenderTheme): Text {
  const chain = (ctx.state.callChain ??= []) as string[];
  const lastLabel = chain[chain.length - 1];
  if (text && lastLabel !== text) chain.push(text);
  return new Text(theme.fg("muted", chain.length > 0 ? chain.join("\n") : "running…"), 0, 0);
}

function finalResultMetadata(text: string, ctx: PtcRenderContext, theme: PtcRenderTheme) {
  const outputLines = text.split("\n").filter((line) => line.trim().length > 0);
  const lineCount = outputLines.length;
  const countLabel = `${lineCount} line${lineCount !== 1 ? "s" : ""}`;
  const callCount = (ctx.state.callChain as string[] | undefined)?.length ?? 0;
  const callSuffix =
    callCount > 0 ? theme.fg("dim", ` · ${callCount} call${callCount !== 1 ? "s" : ""}`) : "";
  return { outputLines, countLabel, callSuffix };
}

function renderPtcExpandedFinal(text: string, ctx: PtcRenderContext, theme: PtcRenderTheme): Text {
  const { countLabel, callSuffix } = finalResultMetadata(text, ctx, theme);
  const code = ctx.args?.code ?? "";
  const codeBlock = code.trim()
    ? `${theme.fg("muted", "─── script ───")}
${code.trim()}
${theme.fg("muted", "─── output ───")}`
    : "";
  return new Text(
    theme.fg("success", "✓ ") +
      theme.fg("muted", countLabel) +
      callSuffix +
      (codeBlock ? "\n" + codeBlock : "") +
      "\n" +
      (text || "(no output)"),
    0,
    0,
  );
}

function renderPtcCollapsedFinal(text: string, ctx: PtcRenderContext, theme: PtcRenderTheme): Text {
  const { outputLines, countLabel, callSuffix } = finalResultMetadata(text, ctx, theme);
  const firstLine = outputLines[0]?.substring(0, 72) ?? "";
  const hiddenOutputLines = Math.max(0, outputLines.length - (firstLine ? 1 : 0));
  let collapsed =
    theme.fg("success", "✓ ") +
    theme.fg("muted", countLabel) +
    callSuffix +
    (firstLine ? "  " + theme.fg("text", firstLine) : "");

  if (hiddenOutputLines > 0) {
    collapsed += `${theme.fg("muted", `\n... (${hiddenOutputLines} more lines,`)} ${toolExpandKeyHint()}${theme.fg("muted", ")")}`;
  } else {
    collapsed += `\n${toolExpandHint(theme)}`;
  }

  return new Text(collapsed, 0, 0);
}
