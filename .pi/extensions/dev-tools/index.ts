/**
 * dev-tools extension — registers language-server-backed code intelligence.
 *
 * Use the interactive tool for diagnostics, navigation, symbol rename, call
 * hierarchy, and symbols. Diagnostics are useful before commit or review.
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
import { registerAgentToolsOnSessionStart, ToolCapability } from "../_shared/agent-tools";
import { txt } from "../_shared/result";
import { formatError } from "../_shared/errors";
import { DEV_TOOLS_ACTIONS, type DevToolsParams, buildClientRequest } from "./request";
import {
  createDevToolsParameterSchema,
  DEV_TOOLS_READ_ACTIONS,
  DEV_TOOLS_TOOL_DESCRIPTIONS,
  DEV_TOOLS_WRITE_ACTIONS,
} from "./action-contract";
import { registerCleanupCommand } from "./cleanup";

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const client = new LspClient();

  registerCleanupCommand(pi);

  // ─── dev-tools tool ───────────────────────────────────────────────────────

  const description =
    "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, " +
    "go-to-implementation, find-references, symbol rename, incoming/outgoing call hierarchy, " +
    "document/workspace symbols. Rename applies language-server workspace edits to disk. " +
    "Communicates with a shared daemon that " +
    "manages typescript-language-server (for .ts/.tsx/.js), bash-language-server " +
    "(for .sh/.bash/.zsh/.ksh), and nil (for .nix files), spawning each on first use. " +
    "Diagnostics supports bulk checks: pass multiple paths to check all files in one call.";

  const toolParameters = createDevToolsParameterSchema(
    StringEnum(DEV_TOOLS_ACTIONS, { description: DEV_TOOLS_TOOL_DESCRIPTIONS.action }),
  );

  const readAgentParameters = createDevToolsParameterSchema(
    StringEnum(DEV_TOOLS_READ_ACTIONS, { description: DEV_TOOLS_TOOL_DESCRIPTIONS.action }),
  );
  const writeAgentParameters = createDevToolsParameterSchema(
    StringEnum(DEV_TOOLS_WRITE_ACTIONS, { description: DEV_TOOLS_TOOL_DESCRIPTIONS.action }),
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

  const readAgentTool: AgentTool<typeof readAgentParameters, LspResult | null> = {
    name: "dev-tools",
    label: "Dev Tools",
    description:
      "Language-server-backed diagnostics and code intelligence for supported coding languages.",
    parameters: readAgentParameters,
    execute: executeDevTools,
  };
  const writeAgentTool: AgentTool<typeof writeAgentParameters, LspResult | null> = {
    name: "dev-tools-edit",
    label: "Dev Tools Edit",
    description: "Language-server-backed code edits. Renames symbols across supported files.",
    parameters: writeAgentParameters,
    execute: executeDevTools,
  };
  registerAgentToolsOnSessionStart(pi, [
    { tool: readAgentTool, capabilities: [ToolCapability.Read] },
    { tool: writeAgentTool, capabilities: [ToolCapability.Write] },
  ]);

  pi.registerTool({
    name: "dev-tools",
    label: "Dev Tools",
    description: description,
    promptSnippet:
      "Language-server-backed code intelligence — diagnostics, hover, definitions, " +
      "implementations, references, symbol rename, call hierarchy, and symbols for supported coding languages.",
    promptGuidelines: [
      "Use dev-tools symbols to orient in files and search workspace symbols for supported coding languages.",
      "Use dev-tools definition to locate declarations, implementation to find concrete implementations, and hover to inspect types and documentation.",
      "Use dev-tools rename to rename symbols across supported files. Use edit for non-symbol text changes.",
      "Use dev-tools incoming-calls before changing a callable signature and outgoing-calls to map dependencies before refactoring.",
      "Use dev-tools diagnostics to validate changed code before commit or review.",
      "Use rg only for text or pattern searches in strings, comments, config values, generated files, and unsupported file types.",
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
