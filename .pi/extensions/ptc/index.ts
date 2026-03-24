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
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { ToolRegistry } from "./tool-registry";
import { PtcExecutor } from "./executor";
import { BLOCKED_TOOLS } from "./types";

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
        const output = await executor.execute(code, ctx, signal, onUpdate);
        return { content: [txt(output || "(no output)")], details: {} };
      } catch (e: unknown) {
        // Throw so pi marks it isError: true and reports to the LLM
        throw new Error(formatError(e, "ptc"));
      }
    },

    renderCall(args, theme, _ctx) {
      const firstLine = args.code.split("\n")[0].trim();
      const preview =
        firstLine.length > 70 ? firstLine.substring(0, 70) + "…" : firstLine;
      return new Text(
        theme.fg("toolTitle", theme.bold("ptc ")) + theme.fg("muted", preview),
        0,
        0,
      );
    },

    renderResult(result, _opts, theme, _ctx) {
      const first = result.content[0];
      const text = first?.type === "text" ? (first.text ?? "") : "";
      // pi adds isError at runtime; cast to access it
      const isError = (result as unknown as { isError?: boolean }).isError;
      if (isError) {
        return new Text(theme.fg("error", text || "error"), 0, 0);
      }
      const preview = text.split("\n")[0].substring(0, 80);
      return new Text(theme.fg("success", "✓ ") + theme.fg("text", preview), 0, 0);
    },
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
