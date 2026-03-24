/**
 * @module ptc/wrapper-gen
 * @purpose Generate TypeScript async wrapper functions for each available tool.
 *
 * Each wrapper calls __rpc_call(toolName, params) and returns the text result.
 * Tool names with hyphens (e.g. "dev-tools") are mapped to snake_case identifiers
 * (e.g. "dev_tools") since hyphens are not valid in JS identifiers.
 */

import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { BLOCKED_TOOLS } from "./types";

/**
 * Convert a tool name to a valid JavaScript identifier.
 * "dev-tools" → "dev_tools", "read_pdf" → "read_pdf"
 */
export function toIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

/**
 * Generate a single async wrapper function for a tool.
 * The wrapper delegates to __rpc_call with the original tool name.
 * __rpc_call is imported by the generated file from subprocess-preamble.ts.
 */
function generateWrapper(tool: ToolInfo): string {
  const fnName = toIdentifier(tool.name);
  const rpcName = JSON.stringify(tool.name); // original name for RPC dispatch
  return [
    `/** ${tool.description.split("\n")[0].substring(0, 100)} */`,
    `async function ${fnName}(params: Record<string, unknown> = {}): Promise<string> {`,
    `  return __rpc_call(${rpcName}, params);`,
    `}`,
  ].join("\n");
}

/**
 * Generate all tool wrapper functions for injection into the subprocess.
 *
 * Intentional double-filter on BLOCKED_TOOLS: callers (getAvailableTools) already
 * strip blocked tools, but this is a pure code-gen function that must be safe to
 * call with any ToolInfo[] slice — defence-in-depth at negligible cost.
 */
export function generateWrappers(tools: ToolInfo[]): string {
  return tools
    .filter((t) => !BLOCKED_TOOLS.has(t.name))
    .map((t) => generateWrapper(t))
    .join("\n\n");
}
