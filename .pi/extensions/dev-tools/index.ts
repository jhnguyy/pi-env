/**
 * dev-tools extension — registers language-server-backed code intelligence.
 *
 * Use the interactive tool for diagnostics, navigation, symbol rename, call
 * hierarchy, and symbols. Diagnostics are useful before commit or review.
 */

import type { Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import "./register-actions"; // side-effect: populate action formatters/renderers for this bundle
import { LspClient } from "./client";
import { formatResult } from "./formatters";
import { registerDevToolsLifecycle } from "./lifecycle";
import { renderDevToolsCall, renderDevToolsResult } from "./renderers";
import { txt } from "../_shared/result";
import { registerPublicTool } from "../_shared/tool-render";
import { formatError } from "../_shared/errors";
import * as Request from "./request";
import {
  createDevToolsParameterSchema,
  DEV_TOOLS_TOOL_DESCRIPTIONS,
} from "./action-contract";
import { registerCleanupCommand } from "./cleanup";
import { registerCloseout } from "./closeout";

// ─── Extension ────────────────────────────────────────────────────────────────

type DevToolsRegistrationApi = Pick<
  ExtensionAPI,
  "exec" | "registerCommand" | "registerTool"
>;

export function registerDevTools(pi: DevToolsRegistrationApi, client = new LspClient()) {
  registerCleanupCommand(pi);
  registerCloseout(pi);

  // ─── dev-tools tool ───────────────────────────────────────────────────────

  const description =
    "TypeScript and Bash language intelligence — diagnostics, hover, go-to-definition, " +
    "go-to-implementation, find-references, symbol rename, incoming/outgoing call hierarchy, " +
    "document/workspace symbols. Rename applies language-server workspace edits to disk. " +
    "Communicates with a shared daemon that " +
    "manages the native TypeScript language server (for .ts/.tsx/.js), bash-language-server " +
    "(for .sh/.bash/.zsh/.ksh), and nil (for .nix files), spawning each on first use. " +
    "Diagnostics supports bulk checks: pass multiple paths to check all files in one call.";

  const toolParameters = createDevToolsParameterSchema(
    StringEnum(Request.DEV_TOOLS_ACTIONS, { description: DEV_TOOLS_TOOL_DESCRIPTIONS.action }),
  );

  type DevToolsToolParameters = typeof toolParameters;

  /** Execute the native dev-tools action, including rename. */
  async function executeDevTools(_toolCallId: string, params: Static<DevToolsToolParameters>) {
    try {
      const result = await client.call(Request.buildClientRequest(params));
      return { content: [txt(formatResult(result))], details: result };
    } catch (e) {
      return { content: [txt(formatError(e))], details: null, isError: true };
    }
  }

  registerPublicTool(pi, {
    name: "dev-tools",
    label: "Dev Tools",
    exposure: "deferred",
    namespace: { name: "pi-env", description: "Local analysis, session, web, and issue tools" },
    description: description,
    promptSnippet:
      "Language-server-backed code intelligence — diagnostics, hover, definitions, " +
      "implementations, references, symbol rename, call hierarchy, and symbols for supported coding languages.",
    promptGuidelines: [
      "Prefer dev-tools symbols for file orientation and workspace symbol searches in supported languages.",
      "Use definition, implementation, references, and hover when semantic results can answer the code question efficiently.",
      "Use dev-tools rename for semantic symbol renames across supported files. Use edit for non-symbol text changes.",
      "Use call hierarchy when a signature change or refactor has caller or dependency impact that is not already clear.",
      "Use diagnostics for supported changed code when they add relevant validation evidence.",
      "Use rg for text and pattern searches, or when semantic tools do not cover or answer the question.",
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
}

export default function initDevTools(pi: ExtensionAPI): void {
  registerDevTools(pi);
  // ─── post-edit lifecycle ─────────────────────────────────────────────────
  registerDevToolsLifecycle(pi);
}
