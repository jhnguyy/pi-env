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
import type { DiagnosticsResult, SymbolsResult, LspAction } from "./protocol";
import { isLspSupported, isTypeScript, isHcl } from "./filetypes";
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
    "go-to-implementation, find-references, incoming/outgoing call hierarchy, " +
    "document/workspace symbols. Communicates with a shared daemon that " +
    "manages typescript-language-server (for .ts/.tsx/.js), bash-language-server " +
    "(for .sh/.bash/.zsh/.ksh), and nil (for .nix files), spawning each on first use. " +
    "Also runs hclfmt automatically after editing .hcl files (if hclfmt is on PATH). " +
    "Diagnostics supports bulk checks: pass multiple paths to check all files in one call.";

  const toolParameters = Type.Object({
    action: StringEnum(
      ["diagnostics", "hover", "definition", "implementation", "references", "incoming-calls", "outgoing-calls", "symbols", "status"] as const,
      { description: "Action to perform" },
    ),
    path: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], {
      description:
        "Absolute path to the file. Required for diagnostics, hover, definition, references, and document symbols. " +
        "For diagnostics, pass an array to check multiple files in one call.",
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

    /**
     * Shared request builder for both execute paths.
     * Normalises path (string | string[] | undefined) → daemon wire format.
     * - diagnostics: array → paths[], scalar/single → paths[] (always bulk for consistent format)
     * - hover/definition/references/symbols: require exactly one path; error on multi-path
     */
    function buildClientRequest(params: Record<string, unknown>): Parameters<typeof client.call>[0] {
      const action = params.action as LspAction;
      const rawPath = params.path as string | string[] | undefined;
      const paths = rawPath === undefined ? [] : Array.isArray(rawPath) ? rawPath : [rawPath];

      if (action === "diagnostics") {
        // Always use the bulk path for consistent output format regardless of array length.
        return { action, paths, line: params.line as number | undefined, character: params.character as number | undefined, query: params.query as string | undefined };
      }

      if (["hover", "definition", "implementation", "references", "incoming-calls", "outgoing-calls", "symbols"].includes(action)) {
        if (paths.length > 1) throw new Error(`${action} requires a single path — ${paths.length} were provided`);
        return { action, path: paths[0], line: params.line as number | undefined, character: params.character as number | undefined, query: params.query as string | undefined };
      }

      // status and others: no path needed
      return { action, line: params.line as number | undefined, character: params.character as number | undefined, query: params.query as string | undefined };
    }

    // Register dev-tools as an AgentTool so subagents can use it
    const agentTool: AgentTool<any, any> = {
      name: "dev-tools",
      label: "Dev Tools",
      description: description,
      parameters: toolParameters,
      execute: async (_toolCallId, params) => {
        try {
          const result = await client.call(buildClientRequest(params));
          return { content: [txt(formatResult(result))], details: result };
        } catch (e) {
          return err(formatError(e));
        }
      },
    };
    pi.events.emit("agent-tools:register", { tool: agentTool, capabilities: ["read"] });
  });

  pi.registerTool({
    name: "dev-tools",
    label: "Dev Tools",
    description: description,

    promptSnippet:
      "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, " +
      "go-to-implementation, find-references, incoming/outgoing call hierarchy, symbols. " +
      "Use instead of grep chains for type-aware or shell-aware code navigation. " +
      "Also supports nil (for .nix files), bash-language-server (for .sh/.bash), and hclfmt (for .hcl).",

    promptGuidelines: [
      "Prefer dev-tools over grep/read for ALL code navigation in TypeScript codebases. dev-tools is faster, precise, and avoids reading entire files.",
      "To find where a symbol is defined: dev-tools definition — not grep + read.",
      "To find implementations of an interface or abstract method: dev-tools implementation.",
      "To find all call sites of a function, type, or variable: dev-tools references — not grep -r.",
      "To find what calls a function: dev-tools incoming-calls — maps the blast radius before changing a signature.",
      "To find what a function calls: dev-tools outgoing-calls — maps dependencies before refactoring.",
      "To understand a type, signature, or overload at a usage site: dev-tools hover — not reading the declaration file.",
      "To orient in an unfamiliar file: dev-tools symbols — not reading top-to-bottom.",
      "Before renaming or changing a function signature, use dev-tools references or incoming-calls to find all call sites first.",
      "After editing a .ts file, dev-tools diagnostics runs automatically — check it before proceeding.",
      "After editing a .sh/.bash file, dev-tools diagnostics surfaces shellcheck warnings automatically.",
      "After editing a .nix file, dev-tools diagnostics surfaces nil errors automatically (requires nil on PATH).",
      "After editing a .hcl file, hclfmt -check runs automatically if hclfmt is on PATH — formatting issues are reported.",
      "Diagnostic errors mid-refactor are expected; finish the plan, then fix at the end.",
      "dev-tools uses 1-indexed lines and characters, matching read tool output.",
      "Use grep/rg only for text/pattern searches (comments, strings, config values) where LSP cannot help.",
    ],

    parameters: toolParameters,

    async execute(_toolCallId, params, _signal) {
      try {
        const result = await client.call(buildClientRequest(params));
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

    // ─── Symbol-enriched reads (.ts files, full-file only) ──────────────
    // When reading a TS file without offset/limit, prepend a compact symbol
    // outline so the model sees the file's structure without a separate call.
    if (toolName === "read" && !event.isError) {
      const path = typeof inp?.path === "string" ? inp.path : undefined;
      const hasOffset = inp?.offset != null;
      const hasLimit = inp?.limit != null;

      if (path && isTypeScript(path) && !hasOffset && !hasLimit) {
        try {
          const SYMBOL_TIMEOUT_MS = 500;
          const result = await Promise.race([
            client.call({ action: "symbols", path }),
            new Promise<null>((r) => setTimeout(() => r(null), SYMBOL_TIMEOUT_MS)),
          ]);
          if (result && result.action === "symbols") {
            const symbols = result as SymbolsResult;
            if (symbols.total > 0) {
              const outline = symbols.items
                .map((s) => {
                  const detail = s.detail ? `: ${s.detail}` : "";
                  return `L${s.line} ${s.kind} ${s.name}${detail}`;
                })
                .join("\n");
              const header = `[${symbols.total} symbols]\n${outline}\n---\n`;
              const first = event.content?.[0];
              const existing = first?.type === "text" ? first.text : "";
              return {
                content: [{ type: "text", text: `${header}${existing}` }],
              };
            }
          }
        } catch {
          // Non-fatal — symbol enrichment is best-effort
        }
      }
    }

    // ─── Post-edit checks (edit/write only) ─────────────────────────────
    if ((toolName === "edit" || toolName === "write") && !event.isError) {
      const path: string | undefined =
        typeof inp?.path === "string" ? inp.path :
        typeof inp?.file_path === "string" ? inp.file_path :
        undefined;

      // ─── LSP diagnostics (.ts, .sh, .nix, …) ───────────────────────
      // Race the daemon call against a short timeout. If the LSP responds
      // quickly (diagnostics already cached), results are appended inline.
      // Otherwise skip — the cache will be warm for the next explicit call.
      if (path && isLspSupported(path)) {
        try {
          const AUTO_DIAG_TIMEOUT_MS = 300;
          const result = await Promise.race([
            client.call({ action: "diagnostics", path }),
            new Promise<null>((r) => setTimeout(() => r(null), AUTO_DIAG_TIMEOUT_MS)),
          ]);
          if (result) {
            const diags = result as DiagnosticsResult;
            const summary = formatDiagnosticsSummary(diags, 5);
            if (summary) {
              const first = event.content?.[0];
              const existing = first?.type === "text" ? first.text : "";
              return {
                content: [{ type: "text", text: existing ? `${existing}\n\n${summary}` : summary }],
              };
            }
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
