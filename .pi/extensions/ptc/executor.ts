/**
 * @module ptc/executor
 * @purpose Orchestrates PTC subprocess execution.
 *
 * Flow:
 *   1. Get available tools from registry
 *   2. Generate wrapper functions
 *   3. Compose full TypeScript program (imports subprocess-preamble.ts at its absolute path)
 *   4. Write to a temp .ts file (enables Bun's native TS execution)
 *   5. Spawn `bun run <tmpfile>`
 *   6. Drive RpcBridge until completion or timeout
 *   7. Truncate output, clean up temp file
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { generateId } from "../_shared/id";
import { RpcBridge } from "./rpc-bridge";
import { generateWrappers } from "./wrapper-gen";
import type { ToolRegistry } from "./tool-registry";
import { MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, buildSubprocessEnv, killGracefully } from "./types";

// Absolute path to the preamble file so the generated subprocess script can import it.
// Using import.meta.url ensures correctness regardless of process.cwd().
const PREAMBLE_PATH = new URL("./subprocess-preamble.ts", import.meta.url).pathname;

export class PtcExecutor {
  constructor(
    private pi: ExtensionAPI,
    private registry: ToolRegistry,
  ) {}

  async execute(
    userCode: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionContext,
  ): Promise<string> {
    const tools = this.registry.getAvailableTools(this.pi);
    const wrappers = generateWrappers(tools);
    const fullCode = buildSubprocessCode(PREAMBLE_PATH, wrappers, userCode);

    // Write to temp .ts file — bun run natively handles TypeScript
    const tmpPath = join(tmpdir(), `ptc-${generateId(8)}.ts`);
    writeFileSync(tmpPath, fullCode, { encoding: "utf-8", mode: 0o600 }); // owner-only read/write

    try {
      return await this.runSubprocess(tmpPath, cwd, signal, onUpdate, ctx);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  private async runSubprocess(
    scriptPath: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionContext,
  ): Promise<string> {
    const proc = spawn("bun", ["run", scriptPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSubprocessEnv(),
    });

    // Pre-bind registry.dispatch to this execution's cwd + ctx so RpcBridge
    // only needs (tool, params) — it has no knowledge of ToolRegistry.
    // When ctx is available (pi tool path), extension tools get the real
    // ExtensionContext. When ctx is undefined (subagent path), dispatch
    // creates a minimal { cwd } stub — safe because ptc-eligible extension
    // tools don't use ctx beyond cwd.
    const dispatch = (tool: string, params: Record<string, unknown>) =>
      this.registry.dispatch(tool, params, cwd, undefined, ctx);

    const bridge = new RpcBridge(proc, dispatch, signal, onUpdate);
    const timeoutId = setTimeout(() => killGracefully(proc), MAX_TIMEOUT_MS);

    try {
      const raw = await bridge.completion;
      clearTimeout(timeoutId);
      return truncateOutput(raw);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compose the full TypeScript program injected into the subprocess.
 *
 * Structure:
 *   1. Import __rpc_call from subprocess-preamble.ts (RPC + readline setup)
 *   2. Tool wrapper functions (async function read(params) { ... })
 *   3. User code wrapped in async __user_main()
 *   4. Execution harness (run + send complete/error message)
 */
function buildSubprocessCode(preamblePath: string, wrappers: string, userCode: string): string {
  const indented = userCode
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");

  return [
    `import { __rpc_call } from ${JSON.stringify(preamblePath)};`,
    "",
    "// --- tool wrappers ---",
    wrappers,
    "",
    "// --- user code ---",
    "async function __user_main(): Promise<unknown> {",
    indented,
    "}",
    "",
    "// --- execution harness ---",
    "__user_main()",
    "  .then((result: unknown) => {",
    "    const out = result !== undefined && result !== null ? String(result) : '';",
    `    process.stdout.write(JSON.stringify({ type: 'complete', output: out }) + '\\n');`,
    "    process.exit(0);",
    "  })",
    "  .catch((e: unknown) => {",
    "    const msg = e instanceof Error ? e.message : String(e);",
    "    const stack = e instanceof Error ? e.stack : undefined;",
    `    process.stdout.write(JSON.stringify({ type: 'error', message: msg, stack }) + '\\n');`,
    "    process.exit(1);",
    "  });",
  ].join("\n");
}

function truncateOutput(output: string): string {
  const result = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  if (!result.truncated) return result.content;
  return (
    result.content +
    `\n\n[PTC output truncated — showing first ${MAX_OUTPUT_BYTES} bytes of ${result.totalBytes}]`
  );
}
