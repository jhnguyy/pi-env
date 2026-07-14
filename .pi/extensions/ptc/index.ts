/**
 * ptc — Programmatic Tool Calling extension for pi-env
 */

import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { ToolRegistry } from "./tool-registry";
import { PtcExecutor } from "./executor";
import { BLOCKED_TOOLS } from "./types";
import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";

export default function ptcExtension(pi: ExtensionAPI) {
  const registry = new ToolRegistry(pi);
  const executor = new PtcExecutor(pi, registry);

  pi.registerTool({
    name: "ptc",
    label: "Programmatic Tool Calling",
    description: DESCRIPTION,
    promptSnippet:
      "Run a TypeScript script that calls tools as async functions — intermediate results stay out of context",
    promptGuidelines: [
      "Prefer ptc over sequential tool calls when you need the same tool more than twice or want to filter results before they enter context.",
      "ptc is best for aggregation, loops, and conditional branching over tool output.",
      "Avoid ptc for one-off tool calls — the overhead is not worth it.",
    ],
    parameters: Type.Object({
      code: Type.String({
        description: PARAM_DESCRIPTION,
      }),
    }),

    async execute(_toolCallId, { code }, signal, onUpdate, ctx) {
      try {
        const output = await executor.execute(code, ctx.cwd, signal, onUpdate, ctx);
        return { content: [txt(output || "(no output)")], details: {} };
      } catch (e: unknown) {
        throw new Error(formatError(e, "ptc"));
      }
    },

    renderCall(args, theme, _ctx) {
      const lines = args.code.split("\n");
      const lineCount = lines.filter((l) => l.trim().length > 0).length;
      const firstCodeLine =
        lines
          .find((l) => {
            const t = l.trim();
            return t.length > 0 && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
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

  pi.on(PiEvent.SessionStart, (_event, ctx) => {
    const sessionCwd = ctx.cwd;
    const ptcAgentTool: AgentTool<any, any> = {
      name: "ptc",
      label: "Programmatic Tool Calling",
      description: DESCRIPTION,
      parameters: Type.Object({
        code: Type.String({ description: PARAM_DESCRIPTION }),
      }),
      execute: async (_toolCallId, params, signal, onUpdate) => {
        try {
          const { code } = params as { code: string };
          const output = await executor.execute(code, sessionCwd, signal, onUpdate);
          return { content: [txt(output || "(no output)")], details: {} };
        } catch (e: unknown) {
          throw new Error(formatError(e, "ptc"));
        }
      },
    };
    registerAgentTools(pi, {
      tool: ptcAgentTool,
      capabilities: [ToolCapability.Read, ToolCapability.Write, ToolCapability.Execute],
    });
  });
}

const DESCRIPTION = [
  "Run a TypeScript/JavaScript script where active available tools are async functions.",
  "Only console.log() output and explicit return values are returned; intermediate tool results stay out of context.",
  "Tool calls must be awaited and use a single object argument; hyphens in tool names become underscores.",
  "Limits: timeout 120 s, max output 50 KB, max tool calls per run 100.",
  "Blocked tools must be called directly, not inside ptc: " + [...BLOCKED_TOOLS].join(", "),
].join("\n");

const PARAM_DESCRIPTION = [
  "The script body to execute. Write it as if it is the body of an async function:",
  "top-level await is supported, variables declared at the top level persist for the whole script.",
  "",
  "Tool names: hyphens become underscores (dev-tools → dev_tools).",
  "Each tool accepts a single object argument: await toolName({ param1: val1, param2: val2 }).",
  "All tool calls must be awaited — tools are async.",
  "",
  "Return a string to set the output, or use console.log(). Both are captured.",
  "Throwing an error marks the result as failed.",
  "For scripts that can fail, wrap calls in try/catch and rethrow with tool-specific context.",
].join("\n");

interface PtcRenderTheme {
  fg(style: string, text: string): string;
}

interface PtcRenderContext {
  state: Record<string, unknown>;
  args?: { code?: string };
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
    collapsed += `${theme.fg("muted", `\n... (${hiddenOutputLines} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
  } else {
    collapsed += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
  }

  return new Text(collapsed, 0, 0);
}
