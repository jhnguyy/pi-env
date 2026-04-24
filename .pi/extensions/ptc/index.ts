/**
 * ptc — Programmatic Tool Calling extension for pi-env
 *
 * Lets the model write a TypeScript script that calls tools as async functions
 * in a single round-trip. Only console.log() output and return values reach the
 * context window — intermediate tool results stay in subprocess memory.
 *
 * Design: see projects/homelab/ptc_extension_design.md in vault
 *
 * Architecture:
 *   index.ts        — extension entry, installs intercept, registers tool
 *   tool-registry.ts — registerTool intercept + createXxxToolDefinition dispatch
 *   executor.ts     — temp file + Bun subprocess lifecycle
 *   rpc-bridge.ts   — parent-side JSON-over-stdio RPC dispatcher
 *   subprocess-preamble.ts — RPC client code running inside the subprocess
 *   wrapper-gen.ts  — generates async wrapper functions from ToolInfo[]
 *   types.ts        — constants, blocklist, RPC message types
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { ToolRegistry } from "./tool-registry";
import { PtcExecutor } from "./executor";
import { BLOCKED_TOOLS } from "./types";
import type { ExtToolRegistration } from "../subagent/types";

export default function ptcExtension(pi: ExtensionAPI) {
  // ToolRegistry installs the registerTool intercept immediately — before any
  // tool below is registered. Tools from extensions that load AFTER ptc will
  // be captured. Built-in tools always work via createXxxToolDefinition().
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
        // Throw so pi marks it isError: true and reports to the LLM
        throw new Error(formatError(e, "ptc"));
      }
    },

    renderCall(args, theme, _ctx) {
      const lines = args.code.split("\n");
      const lineCount = lines.filter((l) => l.trim().length > 0).length;
      // Find first meaningful line — skip blanks and comments.
      // Template literals start with a newline so [0] is always "".
      const firstCodeLine =
        lines.find((l) => {
          const t = l.trim();
          return t.length > 0 && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
        })?.trim() ?? "";
      const preview = firstCodeLine.length > 72 ? firstCodeLine.substring(0, 72) + "…" : firstCodeLine;
      return new Text(
        theme.fg("toolTitle", theme.bold("ptc")) +
          theme.fg("muted", ` ${lineCount}L`) +
          (preview ? "  " + theme.fg("text", preview) : ""),
        0,
        0,
      );
    },

    renderResult(result, opts, theme, ctx) {
      const { isPartial } = opts;
      const first = result.content[0];
      const text = first?.type === "text" ? (first.text ?? "") : "";

      // isError is provided via ctx, not embedded in result
      if (ctx.isError) {
        return new Text(theme.fg("error", "✗ ") + theme.fg("error", text || "error"), 0, 0);
      }

      if (isPartial) {
        // Accumulate each tool-call label into a persistent chain stored in renderer state.
        // Each onUpdate() replaces this.result in ToolExecutionComponent, so only the latest
        // label would be visible without this accumulation.
        if (!ctx.state.callChain) ctx.state.callChain = [];
        const chain: string[] = ctx.state.callChain;
        const lastLabel = chain[chain.length - 1];
        if (text && lastLabel !== text) {
          chain.push(text);
        }
        const lines = chain.length > 0 ? chain.join("\n") : "running…";
        return new Text(theme.fg("muted", lines), 0, 0);
      }

      // Final result
      const outputLines = text.split("\n").filter((l) => l.trim().length > 0);
      const lineCount = outputLines.length;
      const countLabel = `${lineCount} line${lineCount !== 1 ? "s" : ""}`;
      const callCount = (ctx.state.callChain as string[] | undefined)?.length ?? 0;
      const callSuffix =
        callCount > 0
          ? theme.fg("dim", ` · ${callCount} call${callCount !== 1 ? "s" : ""}`)
          : "";

      if (opts.expanded) {
        // Expanded: show the code invocation, then the output
        const code = ctx.args?.code ?? "";
        const codeBlock = code.trim()
          ? theme.fg("muted", "─── script ───") + "\n" + code.trim() + "\n" + theme.fg("muted", "─── output ───")
          : "";
        return new Text(
          theme.fg("success", "✓ ") + theme.fg("muted", countLabel) + callSuffix +
            (codeBlock ? "\n" + codeBlock : "") +
            "\n" + (text || "(no output)"),
          0,
          0,
        );
      }

      // Collapsed: icon + line count + call count + first non-empty output line
      const firstLine = outputLines[0]?.substring(0, 72) ?? "";
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("muted", countLabel) + callSuffix +
          (firstLine ? "  " + theme.fg("text", firstLine) : ""),
        0,
        0,
      );
    },
  });

  // ─── Agent tool registration ──────────────────────────────────────────────────
  // Register ptc as an AgentTool so subagents can run multi-tool scripts.
  // Captures cwd at session_start — subagents run in-process within the same
  // session, so this is the correct project directory. No ctx available in the
  // AgentTool execute signature, so extension tools called from ptc subagent
  // scripts get a { cwd } stub (safe: ptc-eligible ext tools don't use ctx).
  pi.on("session_start", (_event, ctx) => {
    const sessionCwd = ctx.cwd;
    const ptcAgentTool: AgentTool<any, any> = {
      name: "ptc",
      label: "Programmatic Tool Calling",
      description: DESCRIPTION,
      parameters: Type.Object({
        code: Type.String({ description: PARAM_DESCRIPTION }),
      }),
      execute: async (_toolCallId, { code }, signal, onUpdate) => {
        try {
          const output = await executor.execute(code, sessionCwd, signal, onUpdate);
          return { content: [txt(output || "(no output)")], details: {} };
        } catch (e: unknown) {
          throw new Error(formatError(e, "ptc"));
        }
      },
    };
    pi.events.emit("agent-tools:register", { tool: ptcAgentTool, capabilities: ["read", "write", "execute"] } satisfies ExtToolRegistration);
  });
}

// ─── Description and parameter description ───────────────────────────────────
//
// DESIGN RULE: both constants must be fully self-contained.
// Any model (Claude, GPT, Gemini, local) should be able to write correct ptc
// code from description + param_description alone, without relying on the
// system prompt's Guidelines section or any model-specific intuition.
//
// Tool list is intentionally NOT embedded: this runs at extension load time,
// before other extensions have called registerTool(). The system prompt's
// "Available tools" section lists them — no duplication needed.

/** Tool description: execution contract + example. Self-contained for any model. */
const DESCRIPTION = [
  "Run a TypeScript/JavaScript script where every available tool is an async function.",
  "Only console.log() output and explicit return values are returned to you.",
  "Intermediate tool results stay in the script's memory — they do NOT enter the context window.",
  "",
  "CALLING TOOLS:",
  "  Each tool is a function named after the tool, with hyphens replaced by underscores.",
  "  Pass a single object argument with the tool's named parameters.",
  "  All calls must be awaited.",
  "  Example: await read({ path: 'src/index.ts' })",
  "  Example: await bash({ command: 'git log --oneline -5' })",
  "  Example: await dev_tools({ action: 'diagnostics', path: '/abs/path.ts' })",
  "",
  "OUTPUT:",
  "  Use console.log() to emit results — each call appends a line to the output.",
  "  Alternatively, return a value from the script body; it becomes the output.",
  "  Nothing else reaches you — all other computation is invisible.",
  "",
  "EXAMPLE:",
  "  const raw = await grep({ pattern: 'TODO', path: 'src/' });",
  "  const hits = raw.split('\\n').filter(l => l.trim().length > 0 && !l.includes('.test.'));",
  "  console.log(hits.length + ' TODOs in non-test files');",
  "  for (const h of hits.slice(0, 5)) console.log(h);",
  "",
  "LIMITS:",
  "  Timeout: 120 s | Max output: 50 KB | Max tool calls per run: 100",
  "",
  "BLOCKED TOOLS (must be called directly, not inside ptc):",
  "  " + [...BLOCKED_TOOLS].join(", "),
].join("\n");

/** Parameter description: syntax contract. Tells any model exactly what to write. */
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
].join("\n");
