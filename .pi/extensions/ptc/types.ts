/**
 * @module ptc/types
 * @purpose Shared constants, utilities, and RPC message types for Programmatic Tool Calling.
 */

// ─── Execution limits ─────────────────────────────────────────────────────────

export const MAX_TIMEOUT_MS = 120_000;   // 2 minutes
export const MAX_TOOL_CALLS = 100;       // per execution
export const MAX_OUTPUT_BYTES = 50_000;  // matches pi's DEFAULT_MAX_BYTES
export const MAX_STDERR_BYTES = 10_000;  // cap stderr accumulation in RpcBridge

/**
 * Build the environment for the PTC subprocess.
 *
 * Only vars needed by the Node runtime are forwarded. Secrets (API keys, tokens)
 * are intentionally excluded — tool calls run in the parent process via RPC, so
 * tools still have full env access; only the subprocess's own direct operations
 * are restricted.
 */
export function buildSubprocessEnv(): Record<string, string | undefined> {
  const SAFE_VARS = [
    "PATH",            // find executables (node, git, etc.)
    "HOME",            // npm cache + node_modules resolution
    "USER",
    "SHELL",
    "TMPDIR",          // temp file paths
    "TEMP",            // Windows compat
    "TMP",             // Windows compat
    "NODE_ENV",        // may affect module behaviour
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "LANG",            // string encoding
    "LC_ALL",
    "LC_CTYPE",
    // ── Agent coordination (not secrets — IDs and paths) ──
    "PI_BUS_SESSION",  // bus session ID for inter-agent messaging
    "PI_AGENT_ID",     // agent identity on the bus
  ] as const;

  const env: Record<string, string | undefined> = {};
  for (const key of SAFE_VARS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * Function signature for dispatching a tool call inside PTC.
 * Abstracts ToolRegistry away from RpcBridge — the bridge only needs to call
 * a named tool with params and get a string result back.
 */
export type DispatchFn = (tool: string, params: Record<string, unknown>) => Promise<string>;

// ─── Blocklist ────────────────────────────────────────────────────────────────

/**
 * Tools excluded from PTC because they involve recursive agent spawning,
 * long-running process management, or interactive TUI operations.
 *
 * These tools are intentionally unavailable inside a batch script.
 */
export const BLOCKED_TOOLS = new Set<string>([
  "ptc",           // self — prevent recursion
  "subagent",      // in-process agent loops
  "subagent_start", // long-running process management
  "subagent_job",  // long-running process management
  "jit_catch",     // spawns a subagent internally
  "skill_build",   // spawns a subagent internally
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
