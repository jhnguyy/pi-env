/**
 * dev-tools extension — registers the `dev-tools` tool and hooks agent_end processing.
 *
 * dev-tools is a file-extension engine: at agent_end it dispatches each edited
 * file to the backend registered for its extension in BACKEND_CONFIGS:
 *   - mode "lsp"    → bulk diagnostics via the LSP daemon (re-engages model on errors)
 *   - mode "format" → one-shot formatter (silent, best-effort, no model re-engage)
 *
 * The dev-tools interactive tool (hover, definition, symbols, …) routes through
 * the LSP daemon only — it does not interact with format backends.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { spawnSync } from "node:child_process";
import { LspClient } from "./client";
import { formatResult, formatDiagnosticsSummary } from "./formatters";
import { renderDevToolsCall, renderDevToolsResult } from "./renderers";
import type { DaemonRequest, DiagnosticsResult, LspAction } from "./protocol";
import { isSupported, getBackendConfig, type FormatBackendConfig } from "./backend-configs";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";

// ─── Actions that require exactly one path ──────────────────────────────────
const SINGLE_PATH_ACTIONS = new Set<string>([
  "hover", "definition", "implementation", "references",
  "incoming-calls", "outgoing-calls", "symbols",
]);

/**
 * Shared request builder — normalises tool params → daemon wire format.
 * Pure function, no closure dependencies.
 */
function buildClientRequest(params: Record<string, unknown>): Omit<DaemonRequest, "id"> {
  const action = params.action as LspAction;
  const rawPath = params.path as string | string[] | undefined;
  const paths = rawPath === undefined ? [] : Array.isArray(rawPath) ? rawPath : [rawPath];

  if (action === "diagnostics") {
    return { action, paths, line: params.line as number | undefined, character: params.character as number | undefined, query: params.query as string | undefined };
  }

  if (SINGLE_PATH_ACTIONS.has(action)) {
    if (paths.length > 1) throw new Error(`${action} requires a single path — ${paths.length} were provided`);
    return { action, path: paths[0], line: params.line as number | undefined, character: params.character as number | undefined, query: params.query as string | undefined };
  }

  // status and others: no path needed
  return { action, line: params.line as number | undefined, character: params.character as number | undefined, query: params.query as string | undefined };
}

// ─── Format binary cache ──────────────────────────────────────────────────────
// Resolved lazily on first agent_end that contains format-backend files.
// Keyed by binary name so any number of format backends share the same cache.
const _binCache = new Map<string, string | null>();

function resolveBin(name: string): string | null {
  if (_binCache.has(name)) return _binCache.get(name)!;
  const r = spawnSync("which", [name], { encoding: "utf8", stdio: "pipe" });
  const result = r.status === 0 ? r.stdout.trim() || null : null;
  _binCache.set(name, result);
  return result;
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const client = new LspClient();

  // Single set tracking all supported edited files during the agent run.
  // Partitioned by backend mode at agent_end, not at collection time.
  const pendingFiles = new Set<string>();

  // ─── dev-tools tool ───────────────────────────────────────────────────────

  const description =
    "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, " +
    "go-to-implementation, find-references, incoming/outgoing call hierarchy, " +
    "document/workspace symbols. Communicates with a shared daemon that " +
    "manages typescript-language-server (for .ts/.tsx/.js), bash-language-server " +
    "(for .sh/.bash/.zsh/.ksh), and nil (for .nix files), spawning each on first use. " +
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

  /** Shared execute — used by both registerTool and AgentTool registration. */
  async function executeDevTools(_toolCallId: string, params: Record<string, unknown>) {
    try {
      const result = await client.call(buildClientRequest(params));
      return { content: [txt(formatResult(result))], details: result };
    } catch (e) {
      return { content: [txt(formatError(e))], details: null };
    }
  }

  pi.on("session_start", () => {
    pendingFiles.clear();

    // Register dev-tools as an AgentTool so subagents can use it
    const agentTool: AgentTool<any, any> = {
      name: "dev-tools",
      label: "Dev Tools",
      description: description,
      parameters: toolParameters,
      execute: executeDevTools,
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
      "Also supports nil (for .nix files) and bash-language-server (for .sh/.bash).",
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
      "After the agent finishes, all edited files are automatically checked for diagnostics. If errors are found, the agent is re-engaged to triage.",
      "Diagnostic errors mid-refactor are expected; finish the plan — diagnostics run at the end.",
      "dev-tools uses 1-indexed lines and characters, matching read tool output.",
      "Use grep/rg only for text/pattern searches (comments, strings, config values) where LSP cannot help.",
    ],
    parameters: toolParameters,
    async execute(toolCallId, params, _signal) {
      return executeDevTools(toolCallId, params as Record<string, unknown>);
    },
    renderCall(args, theme, _ctx) {
      return renderDevToolsCall(args, theme);
    },
    renderResult(result, opts, theme, _ctx) {
      return renderDevToolsResult(result, opts, theme);
    },
  });

  // ─── tool_result hook: accumulate edited files ────────────────────────────
  // Collect all edit/write targets into pendingFiles. At agent_end the set is
  // partitioned by backend mode — we don't need to know mode at collection time.
  pi.on("tool_result", async (event) => {
    if ((event.toolName !== "edit" && event.toolName !== "write") || event.isError) return;
    const inp = event.input as Record<string, unknown> | null | undefined;
    const path: string | undefined =
      typeof inp?.path === "string" ? inp.path :
      typeof inp?.file_path === "string" ? inp.file_path :
      undefined;
    if (path && isSupported(path)) pendingFiles.add(path);
  });

  // ─── agent_end: dispatch by backend mode ──────────────────────────────────
  // Partition pendingFiles into LSP (diagnostics) and format (one-shot) groups,
  // then process each. Adding a new backend type requires only a new BACKEND_CONFIGS
  // entry — no changes needed here.
  pi.on("agent_end", async () => {
    const files = [...pendingFiles];
    pendingFiles.clear();
    if (files.length === 0) return;

    const lspFiles: string[] = [];
    const formatFiles: Array<{ file: string; config: FormatBackendConfig }> = [];

    for (const file of files) {
      const config = getBackendConfig(file);
      if (!config) continue;
      if (config.mode === "lsp") {
        lspFiles.push(file);
      } else {
        formatFiles.push({ file, config });
      }
    }

    // ── LSP diagnostics ────────────────────────────────────────────────────
    // Batch all LSP files in a single daemon call. Re-engages the model if
    // errors are found so it can triage and fix before the session ends.
    if (lspFiles.length > 0) {
      try {
        const result = await client.call({ action: "diagnostics", paths: lspFiles });
        if (result) {
          const diags = result as DiagnosticsResult;
          const summary = formatDiagnosticsSummary(diags, 10);
          if (summary) {
            pi.sendMessage(
              {
                customType: "dev-tools-diagnostics",
                content: `[post-edit diagnostics]\n${summary}`,
                display: true,
              },
              { triggerTurn: true },
            );
          }
        }
      } catch {
        // Non-fatal — diagnostics are best-effort
      }
    }

    // ── Format backends ────────────────────────────────────────────────────
    // One-shot per file. Runs after diagnostics so the model is not re-engaged
    // just for formatting. Silent on no-op; reports names of formatted files.
    // Binary availability is checked lazily and cached for the process lifetime.
    if (formatFiles.length > 0) {
      const formatted: string[] = [];
      for (const { file, config } of formatFiles) {
        const bin = resolveBin(config.binaryName);
        if (!bin) continue;
        try {
          const r = spawnSync(bin, config.formatArgs(file), {
            encoding: "utf8",
            stdio: "pipe",
            timeout: 10_000,
          });
          if (r.status === 0) formatted.push(file.split("/").pop() ?? file);
        } catch {
          // best-effort — file unreadable, binary crashed, etc.
        }
      }
      if (formatted.length > 0) {
        pi.sendMessage({
          customType: "dev-tools-hclfmt",
          content: `[hclfmt] Auto-formatted ${formatted.length} file(s): ${formatted.join(", ")}`,
          display: true,
        });
      }
    }
  });
}
