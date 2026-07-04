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
import "./register-actions"; // side-effect: populate action formatters/renderers for this bundle
import { LspClient } from "./client";
import { formatResult } from "./formatters";
import {
  type AgentEndFileResult,
  renderActiveAgentEndSummary,
} from "./agent-end";
import { processAgentEndBatch } from "./agent-end-pipeline";
import { renderDevToolsCall, renderDevToolsResult } from "./renderers";
import type { LspResult } from "./protocol";
import { PendingPostEditFiles } from "./post-edit-files";
import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { DEV_TOOLS_ACTIONS, type DevToolsParams, buildClientRequest } from "./request";

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

  // Tracks supported edited files during the agent run. Partitioned by backend
  // mode at agent_end, not at collection time.
  const pendingFiles = new PendingPostEditFiles();
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
      minimum: 1,
      description: "Line number in the file, 1-indexed. Required for hover, definition, implementation, references, and call hierarchy.",
    })),
    character: Type.Optional(Type.Number({
      minimum: 1,
      description: "Column number on the line, 1-indexed. Required for hover, definition, implementation, references, and call hierarchy.",
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

  pi.on(PiEvent.SessionStart, () => {
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
    registerAgentTools(pi, { tool: agentTool, capabilities: [ToolCapability.Read] });
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
  pi.on(PiEvent.Context, async (event) => {
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
  pi.on(PiEvent.ToolResult, async (event) => {
    pendingFiles.recordToolResult(event);
  });

  // ─── agent_end: collect from all backends, render once ─────────────────────
  // Both format and LSP backends push into allResults (AgentEndFileResult[]).
  // One sendMessage at the end covers everything. triggerTurn fires only when
  // LSP results have errors (format errors are informational, no re-engage).
  // See agent-end.ts for types, mappers, and the renderer.
  pi.on(PiEvent.AgentEnd, async () => {
    const files = pendingFiles.drain();
    if (files.length === 0) return;

    // Run formatters before LSP diagnostics, then replace stale active issues
    // for every file processed in this pass.
    const processed = await processAgentEndBatch(activeAgentEndResults, files, {
      resolveFormatBinary: resolveBin,
      runFormat: (bin, args) => spawnSync(bin, args, {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 10_000,
      }),
      runDiagnostics: (paths) => client.call({ action: "diagnostics", paths }),
    });

    // One displayed message, all backends. Defer the send until the next event-loop turn:
    // agent_end is emitted before pi marks the agent idle, so sendMessage called
    // directly in this handler is treated as in-flight steering/follow-up queue
    // data. Once deferred, non-error summaries are appended immediately, and LSP
    // errors can start a synthetic follow-up turn with the diagnostics in context.
    const summary = processed.summary;
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
