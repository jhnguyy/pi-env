/**
 * ptc — Programmatic Tool Calling extension for pi-env
 *
 * Lets Claude write TypeScript code that calls tools as async functions in a
 * single LLM round-trip. Only console.log() output and return values reach the
 * context window — intermediate results stay in subprocess memory.
 *
 * Design: see projects/homelab/ptc_extension_design.md in vault
 *
 * Architecture:
 *   index.ts        — extension entry, installs intercept, registers tool
 *   tool-registry.ts — registerTool intercept + createXxxToolDefinition dispatch
 *   executor.ts     — temp file + Bun subprocess lifecycle
 *   rpc-bridge.ts   — parent-side JSON-over-stdio RPC dispatcher
 *   rpc-client.ts   — builds the preamble injected into subprocess
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
import { generateWrappers } from "./wrapper-gen";
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
    description: buildDescription(pi, registry),
    promptSnippet:
      "Execute TypeScript code that calls multiple tools in one round-trip, keeping intermediate results out of context",
    promptGuidelines: [
      "Use ptc when you need to call the same tool many times (>3) or want to filter/aggregate results before returning.",
      "Only console.log() output and return values reach the context — intermediate tool results are invisible.",
      "Blocked tools (use directly instead): " + [...BLOCKED_TOOLS].join(", "),
    ],
    parameters: Type.Object({
      code: Type.String({
        description: [
          "TypeScript code to execute. Available tools are async functions.",
          "Use console.log() to output results. Hyphens in tool names become underscores (e.g. dev-tools → dev_tools).",
          "The code runs inside an async function — top-level await is supported.",
        ].join(" "),
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

  pi.on("session_shutdown", async () => {
    // No persistent subprocess or resources to clean up
  });
}

// ─── Description builder ──────────────────────────────────────────────────────

function buildDescription(pi: ExtensionAPI, registry: ToolRegistry): string {
  const { available } = generateWrappers(registry.getAvailableTools(pi));

  const toolList = available
    .map((t) => {
      const alias = t.identifier !== t.name ? ` (call as \`${t.identifier}\`)` : "";
      return `  ${t.name}${alias} — ${t.description}`;
    })
    .join("\n");

  return [
    "Execute TypeScript code that calls tools as async functions in a single LLM round-trip.",
    "",
    "Use when you need to:",
    "  - Call the same tool many times (read 20 files, grep across many paths)",
    "  - Filter or aggregate results before reporting",
    "  - Conditional logic based on intermediate results",
    "  - Avoid token waste from intermediate results entering context",
    "",
    "Each tool is an async function. console.log() output and return values reach the context.",
    "Hyphens in tool names become underscores (dev-tools → dev_tools).",
    "",
    "Example:",
    "  const raw = await grep({ pattern: 'TODO', path: 'src/', recursive: true });",
    "  const lines = raw.split('\\n').filter(l => !l.includes('.test.'));",
    "  console.log(`${lines.length} TODOs in non-test files:\\n${lines.slice(0, 10).join('\\n')}`);",
    "",
    `Limits: ${Math.round(120)} s timeout · 50 KB max output · 100 tool calls max`,
    "",
    "Blocked tools (use directly, not via ptc): " + [...BLOCKED_TOOLS].join(", "),
    "",
    "Available tools:",
    toolList || "  (none — check extension load order)",
  ].join("\n");
}
