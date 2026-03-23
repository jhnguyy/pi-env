/**
 * @module ptc/types
 * @purpose Shared constants and RPC message types for Programmatic Tool Calling.
 */

// ─── Execution limits ─────────────────────────────────────────────────────────

export const MAX_TIMEOUT_MS = 120_000;   // 2 minutes
export const MAX_TOOL_CALLS = 100;       // per execution
export const MAX_OUTPUT_BYTES = 50_000;  // matches pi's DEFAULT_MAX_BYTES

// ─── Blocklist ────────────────────────────────────────────────────────────────

/**
 * Tools excluded from PTC because they involve recursive agent spawning,
 * long-running process management, or interactive TUI operations.
 *
 * TODO(upstream): when pi exposes pi.executeTool(name, params, ctx) as a
 * first-class API, the registerTool intercept in tool-registry.ts can be
 * removed entirely. The blocklist stays regardless — these tools are
 * intentionally unavailable inside a batch script.
 */
export const BLOCKED_TOOLS = new Set<string>([
  "ptc",          // self — prevent recursion
  "orch",         // spawns workers, manages worktrees
  "tmux",         // pane management, interactive sessions
  "subagent",     // in-process agent loops
  "jit_catch",    // spawns a subagent internally
  "skill_build",  // spawns a subagent internally
]);

// ─── RPC message types ────────────────────────────────────────────────────────

/** Messages written to stdout by the subprocess (read by parent RpcBridge). */
export type RpcOutbound =
  | { type: "tool_call"; id: string; tool: string; params: Record<string, unknown> }
  | { type: "complete"; output: string }
  | { type: "error"; message: string; stack?: string };

/** Messages written to subprocess stdin by the parent RpcBridge. */
export type RpcInbound =
  | { type: "tool_result"; id: string; result: string }
  | { type: "tool_error"; id: string; error: string };
