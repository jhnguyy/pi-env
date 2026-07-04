/**
 * dev-tools extension — registers the `dev-tools` tool and hooks agent_end processing.
 *
 * dev-tools is a file-extension engine: at agent_end it dispatches each edited
 * file to the backend registered for its extension in BACKEND_CONFIGS:
 *   - mode "format" → one-shot formatter (silent, best-effort, no model re-engage)
 *   - mode "lsp"    → bulk diagnostics via the LSP daemon (re-engages model on errors)
 *
 * **Ordering invariant**: format backends run BEFORE LSP diagnostics in agent_end.
 * LSP diagnostics can re-engage the model when errors are found. The actual
 * sendMessage call is deferred until after agent_end returns because pi still treats
 * the agent as streaming while agent_end handlers run; calling sendMessage there
 * would enqueue diagnostics instead of starting the synthetic follow-up turn.
 *
 * The dev-tools interactive tool (hover, definition, symbols, …) routes through
 * the LSP daemon only — it does not interact with format backends.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { LspClient } from "./client";
import { formatResult } from "./formatters";
import {
  type AgentEndFileResult,
  diagnosticsToAgentEndResults,
  formatAgentEndErrorResult,
  processAgentEndResults,
  renderActiveAgentEndSummary,
} from "./agent-end";
import { renderDevToolsCall, renderDevToolsResult } from "./renderers";
import type { DaemonRequest, DiagnosticsResult, LspResult } from "./protocol";
import { isSupported, getBackendConfig, type FormatBackendConfig } from "./backend-configs";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";

// ─── Tool action enum ───────────────────────────────────────────────────────
enum DevToolsAction {
  Diagnostics = "diagnostics",
  Hover = "hover",
  Definition = "definition",
  Implementation = "implementation",
  References = "references",
  IncomingCalls = "incoming-calls",
  OutgoingCalls = "outgoing-calls",
  Symbols = "symbols",
  Status = "status",
}

const DEV_TOOLS_ACTIONS = Object.values(DevToolsAction);

interface DevToolsParams {
  action: DevToolsAction;
  path?: string | string[];
  line?: number;
  character?: number;
  query?: string;
}

/**
 * Shared request builder — normalises tool params → daemon wire format.
 * Pure function, no closure dependencies.
 */
function buildClientRequest(params: DevToolsParams): Omit<DaemonRequest, "id"> {
  const rawPath = params.path;
  const paths = rawPath === undefined ? [] : Array.isArray(rawPath) ? rawPath : [rawPath];

  switch (params.action) {
    case DevToolsAction.Diagnostics:
      return { action: params.action, paths };
    case DevToolsAction.Status:
      return { action: params.action };
    case DevToolsAction.Symbols:
      if (paths.length > 1) throw new Error(`${params.action} requires a single path — ${paths.length} were provided`);
      return { action: params.action, path: paths[0], query: params.query };
    case DevToolsAction.Hover:
    case DevToolsAction.Definition:
    case DevToolsAction.Implementation:
    case DevToolsAction.References:
    case DevToolsAction.IncomingCalls:
    case DevToolsAction.OutgoingCalls:
      if (paths.length > 1) throw new Error(`${params.action} requires a single path — ${paths.length} were provided`);
      return { action: params.action, path: paths[0], line: params.line, character: params.character };
  }
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
  // Current post-edit issues keyed by file. Older dev-tools-agent-end messages
  // are filtered out of model context and replaced with this live summary.
  const activeAgentEndResults = new Map<string, AgentEndFileResult>();

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
      DEV_TOOLS_ACTIONS,
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

  type DevToolsToolParameters = typeof toolParameters;

  /** Shared execute — used by both registerTool and AgentTool registration. */
  async function executeDevTools(_toolCallId: string, params: Static<DevToolsToolParameters>) {
    try {
      const result = await client.call(buildClientRequest(params as DevToolsParams));
      return { content: [txt(formatResult(result))], details: result };
    } catch (e) {
      return { content: [txt(formatError(e))], details: null };
    }
  }

  pi.on("session_start", () => {
    pendingFiles.clear();
    activeAgentEndResults.clear();

    // Register dev-tools as an AgentTool so subagents can use it
    const agentTool: AgentTool<DevToolsToolParameters, LspResult | null> = {
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
      return executeDevTools(toolCallId, params);
    },
    renderCall(args, theme, _ctx) {
      return renderDevToolsCall(args, theme);
    },
    renderResult(result, opts, theme, _ctx) {
      return renderDevToolsResult(result, opts, theme);
    },
  });

  // ─── context hook: collapse stale post-edit hints ─────────────────────────
  pi.on("context", async (event) => {
    const messages = event.messages.filter((message) => {
      const customType = (message as { customType?: string }).customType;
      return customType !== "dev-tools-agent-end";
    });
    const summary = renderActiveAgentEndSummary(activeAgentEndResults);
    if (summary) {
      messages.push({
        role: "custom",
        customType: "dev-tools-agent-end",
        content: `[post-edit]\n${summary}`,
        display: false,
        timestamp: Date.now(),
      });
    }
    return { messages };
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

  // ─── agent_end: collect from all backends, render once ─────────────────────
  // Both format and LSP backends push into allResults (AgentEndFileResult[]).
  // One sendMessage at the end covers everything. triggerTurn fires only when
  // LSP results have errors (format errors are informational, no re-engage).
  // See agent-end.ts for types, mappers, and the renderer.
  pi.on("agent_end", async () => {
    const files = [...pendingFiles];
    pendingFiles.clear();
    if (files.length === 0) return;

    const lspFiles: string[] = [];
    const formatFiles: Array<{ file: string; config: FormatBackendConfig }> = [];

    for (const file of files) {
      const config = getBackendConfig(file);
      if (!config) continue;
      if (config.mode === "lsp") lspFiles.push(file);
      else formatFiles.push({ file, config });
    }

    const allResults: AgentEndFileResult[] = [];

    // ── Format backends ──────────────────────────────────────────────────
    // Sync + best-effort. Format errors are shown but don’t re-engage the model.
    for (const { file, config } of formatFiles) {
      const bin = resolveBin(config.binaryName);
      if (!bin) continue;
      try {
        const r = spawnSync(bin, config.formatArgs(file), {
          encoding: "utf8",
          stdio: "pipe",
          timeout: 10_000,
        });
        if (r.status !== 0) {
          const detail = (r.stderr as string).trim() || `exit ${r.status}`;
          allResults.push(formatAgentEndErrorResult(config.name, file, detail));
        }
      } catch (e) {
        allResults.push(formatAgentEndErrorResult(
          config.name,
          file,
          e instanceof Error ? e.message : String(e),
        ));
      }
    }

    // ── LSP diagnostics ──────────────────────────────────────────────────
    // Async, batch. LSP errors need the model to fix.
    if (lspFiles.length > 0) {
      try {
        const result = await client.call({ action: "diagnostics", paths: lspFiles });
        if (result) {
          allResults.push(...diagnosticsToAgentEndResults(result as DiagnosticsResult));
        }
      } catch {
        // Non-fatal — diagnostics are best-effort
      }
    }

    // ── Active-state update + render + send ────────────────────────────────
    // Replace any old issues for files processed in this pass. This lets clean
    // diagnostics retire stale post-edit hints from later model contexts.
    const processed = processAgentEndResults(activeAgentEndResults, files, allResults);

    // One displayed message, all backends. Defer the send until the next event-loop turn:
    // agent_end is emitted before pi marks the agent idle, so sendMessage called
    // directly in this handler is treated as in-flight steering/follow-up queue
    // data. Once deferred, non-error summaries are appended immediately, and LSP
    // errors can start a synthetic follow-up turn with the diagnostics in context.
    const summary = processed.batchSummary;
    if (summary) {
      const triggerTurn = processed.triggerTurn;
      const message = {
        customType: "dev-tools-agent-end",
        content: `[post-edit]\n${summary}`,
        display: true,
      };

      setTimeout(() => {
        void pi.sendMessage(
          message,
          triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : undefined,
        );
      }, 0);
    }
  });
}
