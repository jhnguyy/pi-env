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
import { StringEnum } from "@earendil-works/pi-ai";
import "./register-actions"; // side-effect: populate action formatters/renderers for this bundle
import { LspClient } from "./client";
import { formatResult } from "./formatters";
import { registerDevToolsLifecycle } from "./lifecycle";
import { renderDevToolsCall, renderDevToolsResult } from "./renderers";
import type { LspResult } from "./protocol";
import { PiEvent, registerAgentTools, ToolCapability } from "../_shared/agent-tools";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { DEV_TOOLS_ACTIONS, type DevToolsParams, buildClientRequest } from "./request";
import { createDevToolsParameterSchema, DEV_TOOLS_TOOL_DESCRIPTIONS } from "./action-contract";

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const client = new LspClient();

  // ─── dev-tools tool ───────────────────────────────────────────────────────

  const description =
    "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, " +
    "go-to-implementation, find-references, incoming/outgoing call hierarchy, " +
    "document/workspace symbols. Communicates with a shared daemon that " +
    "manages typescript-language-server (for .ts/.tsx/.js), bash-language-server " +
    "(for .sh/.bash/.zsh/.ksh), and nil (for .nix files), spawning each on first use. " +
    "Diagnostics supports bulk checks: pass multiple paths to check all files in one call.";

  const toolParameters = createDevToolsParameterSchema(
    StringEnum(DEV_TOOLS_ACTIONS, { description: DEV_TOOLS_TOOL_DESCRIPTIONS.action }),
  );

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

  // ─── post-edit lifecycle ─────────────────────────────────────────────────
  registerDevToolsLifecycle(pi, {
    runDiagnostics: (paths) => client.call({ action: "diagnostics", paths }),
  });
}
