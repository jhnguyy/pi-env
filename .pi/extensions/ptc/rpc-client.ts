/**
 * @module ptc/rpc-client
 * @purpose Builds the TypeScript preamble injected into the PTC subprocess.
 *
 * The preamble runs inside the Bun subprocess and provides:
 *   - readline-based stdin reader for tool results from parent
 *   - __rpc_call(tool, params) async function for all generated wrappers
 *
 * Protocol (subprocess stdout → parent):
 *   JSON line: { type: "tool_call", id, tool, params }
 *   JSON line: { type: "complete", output }
 *   JSON line: { type: "error", message, stack }
 *   Plain line: console.log() output captured as result
 *
 * Protocol (parent stdin → subprocess):
 *   JSON line: { type: "tool_result", id, result }
 *   JSON line: { type: "tool_error", id, error }
 */

import { MAX_TOOL_CALLS } from "./types";

/**
 * Returns the TypeScript preamble to prepend to user code in the subprocess.
 * This is valid TypeScript evaluated by `bun run`.
 */
export function buildRpcPreamble(): string {
  // Use array join to avoid template-literal-in-template-literal escaping
  return [
    `import { createInterface } from "readline";`,
    ``,
    `const __pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();`,
    `let __callId = 0;`,
    `let __toolCalls = 0;`,
    ``,
    `// Read tool results from parent via stdin`,
    `const __rl = createInterface({ input: process.stdin, terminal: false });`,
    `__rl.on("line", (line: string) => {`,
    `  const trimmed = line.trim();`,
    `  if (!trimmed) return;`,
    `  try {`,
    `    const msg = JSON.parse(trimmed) as { type: string; id: string; result?: string; error?: string };`,
    `    const p = __pending.get(msg.id);`,
    `    if (!p) return;`,
    `    __pending.delete(msg.id);`,
    `    if (msg.type === "tool_result") p.resolve(msg.result ?? "");`,
    `    else p.reject(new Error(msg.error ?? "tool_error"));`,
    `  } catch { /* ignore non-JSON */ }`,
    `});`,
    ``,
    `async function __rpc_call(tool: string, params: Record<string, unknown> = {}): Promise<string> {`,
    `  if (++__toolCalls > ${MAX_TOOL_CALLS}) throw new Error("PTC: exceeded ${MAX_TOOL_CALLS} tool call limit");`,
    `  const id = \`c_\${__callId++}\`;`,
    `  process.stdout.write(JSON.stringify({ type: "tool_call", id, tool, params }) + "\\n");`,
    `  return new Promise<string>((resolve, reject) => { __pending.set(id, { resolve, reject }); });`,
    `}`,
  ].join("\n");
}
