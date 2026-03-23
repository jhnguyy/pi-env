/**
 * @module ptc/executor
 * @purpose Orchestrates PTC subprocess execution.
 *
 * Flow:
 *   1. Get available tools from registry
 *   2. Generate wrapper functions + preamble
 *   3. Compose full TypeScript program
 *   4. Write to a temp .ts file (enables Bun's native TS execution)
 *   5. Spawn `bun run <tmpfile>`
 *   6. Drive RpcBridge until completion or timeout
 *   7. Truncate output, clean up temp file
 */

import { spawn } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { RpcBridge } from "./rpc-bridge";
import { buildRpcPreamble } from "./rpc-client";
import { generateWrappers } from "./wrapper-gen";
import type { ToolRegistry } from "./tool-registry";
import { MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES } from "./types";

export class PtcExecutor {
  constructor(
    private pi: ExtensionAPI,
    private registry: ToolRegistry,
  ) {}

  async execute(
    userCode: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ): Promise<string> {
    const tools = this.registry.getAvailableTools(this.pi);
    const { code: wrappers } = generateWrappers(tools);
    const preamble = buildRpcPreamble();

    const fullCode = buildSubprocessCode(preamble, wrappers, userCode);

    // Write to temp .ts file — bun run natively handles TypeScript
    const tmpPath = join(tmpdir(), `ptc-${randomBytes(8).toString("hex")}.ts`);
    writeFileSync(tmpPath, fullCode, "utf-8");

    try {
      return await this.runSubprocess(tmpPath, ctx, signal, onUpdate);
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
    ctx: ExtensionContext,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ): Promise<string> {
    const proc = spawn("bun", ["run", scriptPath], {
      cwd: ctx.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const bridge = new RpcBridge(proc, this.registry, ctx.cwd, ctx, signal, onUpdate);

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }, 5_000);
    }, MAX_TIMEOUT_MS);

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
 *   1. RPC client preamble (readline setup + __rpc_call)
 *   2. Tool wrapper functions (async function read(params) { ... })
 *   3. User code wrapped in async __user_main()
 *   4. Execution harness (run + send complete/error message)
 */
function buildSubprocessCode(preamble: string, wrappers: string, userCode: string): string {
  const indented = userCode
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");

  return [
    "// --- RPC client preamble ---",
    preamble,
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
