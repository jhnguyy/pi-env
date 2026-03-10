/**
 * LSP Extension — registers the `lsp` tool and hooks auto-diagnostics.
 *
 * Wires together: LspClient, formatters, renderers.
 * The daemon is spawned on first use (managed by client.ts).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { LspClient } from "./client";
import { formatResult, formatDiagnosticsSummary } from "./formatters";
import { renderLspCall, renderLspResult } from "./renderers";
import type { DiagnosticsResult, LspAction } from "./protocol";
import { isLspSupported } from "./filetypes";
import { createHintState, resetHintState, detectLspHint } from "./hints";

export default function (pi: ExtensionAPI) {
  const client = new LspClient();
  const hintState = createHintState();
  let pendingHint: string | null = null;

  pi.on("session_start", () => {
    resetHintState(hintState);
    pendingHint = null;
  });

  // ─── lsp tool ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description:
      "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, " +
      "find-references, document/workspace symbols. Communicates with a shared daemon that " +
      "manages typescript-language-server (for .ts/.tsx/.js) and bash-language-server " +
      "(for .sh/.bash/.zsh/.ksh), spawning each on first use.",

    promptSnippet:
      "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, find-references, symbols. " +
      "Use instead of grep chains for type-aware or shell-aware code navigation.",

    promptGuidelines: [
      "When working in a TypeScript codebase, reach for lsp before grep or read for any symbol-level task.",
      "To find where a symbol is defined: lsp definition — not grep + read.",
      "To find all call sites of a function, type, or variable: lsp references — not grep -r.",
      "To understand a type, signature, or overload at a usage site: lsp hover — not reading the declaration file.",
      "To orient in an unfamiliar file: lsp symbols — not reading top-to-bottom.",
      "After editing a .ts file, lsp diagnostics runs automatically — check it before proceeding.",
      "After editing a .sh/.bash file, lsp diagnostics surfaces shellcheck warnings automatically.",
      "Diagnostic errors mid-refactor are expected; finish the plan, then fix at the end.",
      "lsp uses 1-indexed lines and characters, matching read tool output.",
    ],

    parameters: Type.Object({
      action: StringEnum(
        ["diagnostics", "hover", "definition", "references", "symbols", "status"] as const,
        { description: "Action to perform" },
      ),
      path: Type.Optional(Type.String({
        description: "Absolute path to the file. Required for diagnostics, hover, definition, references, and document symbols.",
      })),
      line: Type.Optional(Type.Number({
        description: "Line number (1-indexed). Required for hover, definition, references.",
      })),
      character: Type.Optional(Type.Number({
        description: "Column number (1-indexed). Required for hover, definition, references.",
      })),
      query: Type.Optional(Type.String({
        description: "Search query for workspace symbols (action=symbols without path).",
      })),
    }),

    async execute(_toolCallId, params, _signal) {
      try {
        const result = await client.call({
          action: params.action as LspAction,
          path: params.path,
          line: params.line,
          character: params.character,
          query: params.query,
        });

        return {
          content: [{ type: "text", text: formatResult(result) }],
          details: result,
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : "LSP error" }],
          details: null,
        };
      }
    },

    renderCall(args, theme) {
      return renderLspCall(args, theme);
    },

    renderResult(result, opts, theme) {
      return renderLspResult(result, opts, theme);
    },
  });

  // ─── Auto-diagnostics + hint hook ───────────────────────────────────────

  pi.on("tool_result", async (event) => {
    const { toolName, input } = event;
    const inp = input as Record<string, unknown> | null | undefined;

    // ─── Auto-diagnostics (edit/write only) ─────────────────────────────
    if ((toolName === "edit" || toolName === "write") && !event.isError) {
      const path: string | undefined =
        typeof inp?.path === "string" ? inp.path :
        typeof inp?.file_path === "string" ? inp.file_path :
        undefined;

      if (path && isLspSupported(path)) {
        try {
          const result = await client.call({ action: "diagnostics", path });
          const diags = result as DiagnosticsResult;
          const summary = formatDiagnosticsSummary(diags, 5);

          if (summary) {
            const first = event.content?.[0];
            const existing = first?.type === "text" ? first.text : "";
            return {
              content: [{ type: "text", text: existing ? `${existing}\n\n${summary}` : summary }],
            };
          }
        } catch {
          // Non-fatal — diagnostics are best-effort
        }
      }
    }

    // ─── LSP hint detection (all tools) ─────────────────────────────────
    // Queue hint for delivery at the next decision boundary (before_agent_start)
    // instead of appending to tool output where it gets buried.
    const hint = detectLspHint(toolName, inp, hintState);
    if (hint) {
      pendingHint = hint;
    }
  });

  // ─── Deliver queued LSP hints at the decision boundary ────────────────
  pi.on("before_agent_start", async () => {
    if (!pendingHint) return {};
    const hint = pendingHint;
    pendingHint = null;
    return {
      message: {
        customType: "lsp-hint",
        content: hint,
        display: false,
      },
    };
  });
}
