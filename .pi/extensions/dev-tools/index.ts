/**
 * dev-tools extension — registers the `dev-tools` tool and hooks auto-diagnostics.
 *
 * Wires together: LspClient, formatters, renderers.
 * The daemon is spawned on first use (managed by client.ts).
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { LspClient } from "./client";
import { formatResult, formatDiagnosticsSummary } from "./formatters";
import { renderDevToolsCall, renderDevToolsResult } from "./renderers";
import type { DiagnosticsResult, LspAction } from "./protocol";
import { isLspSupported, isHcl } from "./filetypes";
import { execFile } from "child_process";
import { promisify } from "util";
import { txt, err } from "../_shared/result";
import { formatError } from "../_shared/errors";

const execFileAsync = promisify(execFile);
import { createHintState, resetHintState, detectDevToolsHint } from "./hints";

// ─── hclfmt check ───────────────────────────────────────────────────────────
// Runs `hclfmt -check <path>` after editing .hcl files. Exit 0 = already
// formatted (silent). Non-zero = formatting diff or syntax error (reported).
// ENOENT (hclfmt not installed) is silently ignored.
async function runHclfmtCheck(filePath: string): Promise<string | null> {
  try {
    await execFileAsync("hclfmt", ["-check", filePath]);
    return null; // formatted correctly
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") return null; // hclfmt not installed — skip
    const output = (e.stderr ?? e.stdout ?? "").trim();
    return output
      ? `⚠ hclfmt:\n${output}`
      : "⚠ hclfmt: file needs formatting — run hclfmt to fix";
  }
}

export default function (pi: ExtensionAPI) {
  const client = new LspClient();
  const hintState = createHintState();
  let pendingHint: string | null = null;

  // ─── dev-tools tool ─────────────────────────────────────────────────────

  const description =
    "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, " +
    "find-references, document/workspace symbols. Communicates with a shared daemon that " +
    "manages typescript-language-server (for .ts/.tsx/.js), bash-language-server " +
    "(for .sh/.bash/.zsh/.ksh), and nil (for .nix files), spawning each on first use. " +
    "Also runs hclfmt automatically after editing .hcl files (if hclfmt is on PATH).";

  const toolParameters = Type.Object({
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
  });

  pi.on("session_start", () => {
    resetHintState(hintState);
    pendingHint = null;

    // Register dev-tools as an AgentTool so subagents can use it
    const agentTool: AgentTool<any, any> = {
      name: "dev-tools",
      label: "Dev Tools",
      description: description,
      parameters: toolParameters,
      execute: async (_toolCallId, params) => {
        try {
          const result = await client.call({
            action: params.action as LspAction,
            path: params.path,
            line: params.line,
            character: params.character,
            query: params.query,
          });
          return { content: [txt(formatResult(result))], details: result };
        } catch (e) {
          return err(formatError(e));
        }
      },
    };
    pi.events.emit("agent-tools:register", agentTool);
  });

  pi.registerTool({
    name: "dev-tools",
    label: "Dev Tools",
    description: description,

    promptSnippet:
      "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, find-references, symbols. " +
      "Use instead of grep chains for type-aware or shell-aware code navigation. " +
      "Also supports nil (for .nix files), bash-language-server (for .sh/.bash), and hclfmt (for .hcl).",

    promptGuidelines: [
      "When working in a TypeScript codebase, reach for dev-tools before grep or read for any symbol-level task.",
      "To find where a symbol is defined: dev-tools definition — not grep + read.",
      "To find all call sites of a function, type, or variable: dev-tools references — not grep -r.",
      "To understand a type, signature, or overload at a usage site: dev-tools hover — not reading the declaration file.",
      "To orient in an unfamiliar file: dev-tools symbols — not reading top-to-bottom.",
      "After editing a .ts file, dev-tools diagnostics runs automatically — check it before proceeding.",
      "After editing a .sh/.bash file, dev-tools diagnostics surfaces shellcheck warnings automatically.",
      "After editing a .nix file, dev-tools diagnostics surfaces nil errors automatically (requires nil on PATH).",
      "After editing a .hcl file, hclfmt -check runs automatically if hclfmt is on PATH — formatting issues are reported.",
      "Diagnostic errors mid-refactor are expected; finish the plan, then fix at the end.",
      "dev-tools uses 1-indexed lines and characters, matching read tool output.",
    ],

    parameters: toolParameters,

    async execute(_toolCallId, params, _signal) {
      try {
        const result = await client.call({
          action: params.action as LspAction,
          path: params.path,
          line: params.line,
          character: params.character,
          query: params.query,
        });
        return { content: [txt(formatResult(result))], details: result };
      } catch (e) {
        // Explicit shape — details must stay LspResult-compatible for renderDevToolsResult.
        return { content: [txt(formatError(e))], details: null };
      }
    },

    renderCall(args, theme, _ctx) {
      return renderDevToolsCall(args, theme);
    },

    renderResult(result, opts, theme, _ctx) {
      return renderDevToolsResult(result, opts, theme);
    },
  });

  // ─── Auto-diagnostics + hint hook ───────────────────────────────────────

  pi.on("tool_result", async (event) => {
    const { toolName, input } = event;
    const inp = input as Record<string, unknown> | null | undefined;

    // ─── Post-edit checks (edit/write only) ─────────────────────────────
    if ((toolName === "edit" || toolName === "write") && !event.isError) {
      const path: string | undefined =
        typeof inp?.path === "string" ? inp.path :
        typeof inp?.file_path === "string" ? inp.file_path :
        undefined;

      // ─── LSP diagnostics (.ts, .sh, .nix, …) ───────────────────────
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

      // ─── hclfmt check (.hcl) ────────────────────────────────────────
      if (path && isHcl(path)) {
        try {
          const msg = await runHclfmtCheck(path);
          if (msg) {
            const first = event.content?.[0];
            const existing = first?.type === "text" ? first.text : "";
            return {
              content: [{ type: "text", text: existing ? `${existing}\n\n${msg}` : msg }],
            };
          }
        } catch {
          // Non-fatal
        }
      }
    }

    // ─── LSP hint detection (all tools) ─────────────────────────────────
    // Queue hint for delivery at the next decision boundary (before_agent_start)
    // instead of appending to tool output where it gets buried.
    const hint = detectDevToolsHint(toolName, inp, hintState);
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
        customType: "dev-tools-hint",
        content: hint,
        display: false,
      },
    };
  });
}
