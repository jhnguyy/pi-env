/**
 * dev-tools extension — registers the `dev-tools` tool.
 *
 * The agent-end lifecycle intentionally does not run diagnostics, formatters, or
 * project-wide analyzers. Those checks can produce stale or distracting feedback
 * during the coding flow, so agents should invoke them manually before commit or
 * review.
 *
 * The dev-tools interactive tool (diagnostics, hover, definition, symbols, …)
 * routes through the LSP daemon.
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
    "Diagnostics supports bulk checks: pass multiple paths to check all files in one call. " +
    "Before commit or review, diagnostics and the project quality harness are useful manual checks.";

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
      "Language-server-backed code intelligence — diagnostics, hover, definitions, " +
      "implementations, references, call hierarchy, and symbols for supported coding languages.",
    promptGuidelines: [
      "For supported coding languages, prefer dev-tools for symbols, definitions, references, hovers, call hierarchy, and diagnostics.",
      "Use text search for strings, comments, config values, generated files, and unsupported file types.",
      "Before commit or review, manually run dev-tools diagnostics on changed code and the project quality harness (`nub run check:all` or `nub run harness:report`).",
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
  registerDevToolsLifecycle(pi);
}
