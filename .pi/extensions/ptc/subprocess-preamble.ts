/**
 * @module ptc/subprocess-preamble
 * @purpose RPC client that runs inside the PTC subprocess.
 *
 * Imported by the generated temp script at its absolute path. Sets up the
 * stdin/stdout JSON-RPC channel and exports __rpc_call for use by the
 * generated tool wrapper functions.
 *
 * Protocol (subprocess stdout → parent RpcBridge):
 *   { type: "tool_call", id, tool, params }
 *   { type: "complete", output }
 *   { type: "error", message, stack }
 *
 * Protocol (parent stdin → subprocess):
 *   { type: "tool_result", id, result }
 *   { type: "tool_error", id, error }
 */

import { createInterface } from "readline";
import { MAX_TOOL_CALLS } from "./types";

const __pending = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>();
let __callId = 0;
let __toolCalls = 0;

// Read tool results from parent via stdin
const __rl = createInterface({ input: process.stdin, terminal: false });
__rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed) as { type: string; id: string; result?: string; error?: string };
    const p = __pending.get(msg.id);
    if (!p) return;
    __pending.delete(msg.id);
    if (msg.type === "tool_result") p.resolve(msg.result ?? "");
    else p.reject(new Error(msg.error ?? "tool_error"));
  } catch { /* ignore non-JSON stdin */ }
});

export async function __rpc_call(tool: string, params: Record<string, unknown> = {}): Promise<string> {
  if (++__toolCalls > MAX_TOOL_CALLS) throw new Error(`PTC: exceeded ${MAX_TOOL_CALLS} tool call limit`);
  const id = `c_${__callId++}`;
  process.stdout.write(JSON.stringify({ type: "tool_call", id, tool, params }) + "\n");
  return new Promise<string>((resolve, reject) => { __pending.set(id, { resolve, reject }); });
}
