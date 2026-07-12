/**
 * @module ptc/executor
 * @purpose Orchestrates PTC subprocess execution.
 */

import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { Effect } from "effect";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { buildCodeFrame, mapGeneratedStackToUserLine } from "../_shared/code-frame";
import { RpcBridge } from "./rpc-bridge";
import { generateWrappers } from "./wrapper-gen";
import type { ToolRegistry } from "./tool-registry";
import { scopedChildProcess } from "../../../src/process/platform.js";
import { MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, buildSubprocessEnv } from "./types";
import {
  createTempScript,
  cleanupTempScript,
  resolvePtcNodeCommand,
  PtcExecutionError,
  PtcExecutionPhase,
} from "./node-runtime";

const PREAMBLE_PATH = fileURLToPath(new URL("./subprocess-preamble.js", import.meta.url));

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
    const runnableCode = transformSubprocessCode(fullCode);

    return Effect.runPromise(
      Effect.acquireUseRelease(
        createTempScript(runnableCode),
        (tmpPath) => this.runSubprocessEffect(tmpPath, userCode, cwd, signal, onUpdate, ctx),
        (tmpPath) => cleanupTempScript(tmpPath),
      ),
    );
  }

  private runSubprocessEffect(
    scriptPath: string,
    userCode: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionContext,
  ): Effect.Effect<string, PtcExecutionError> {
    return Effect.scoped(
      scopedChildProcess(resolvePtcNodeCommand(), [scriptPath], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildSubprocessEnv(),
        timeoutMs: MAX_TIMEOUT_MS,
        killGraceMs: 5_000,
      }).pipe(
        Effect.mapError((cause) => new PtcExecutionError({ phase: PtcExecutionPhase.Run, cause })),
        Effect.flatMap((proc) => this.awaitSubprocessEffect(proc, scriptPath, userCode, cwd, signal, onUpdate, ctx)),
      ),
    );
  }

  private awaitSubprocessEffect(
    proc: ChildProcess,
    scriptPath: string,
    userCode: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionContext,
  ): Effect.Effect<string, PtcExecutionError> {
    const nestedController = new AbortController();
    const abortNested = (): void => nestedController.abort(signal?.reason);
    if (signal?.aborted) abortNested();
    else signal?.addEventListener("abort", abortNested, { once: true });
    const dispatch = (tool: string, params: Record<string, unknown>) =>
      this.registry.dispatch(tool, params, cwd, nestedController.signal, ctx);

    let bridge: RpcBridge | undefined;
    return Effect.tryPromise({
      try: async () => {
        bridge = new RpcBridge(proc, dispatch, nestedController.signal, onUpdate);
        return truncateOutput(await bridge.completion);
      },
      catch: (cause) => new PtcExecutionError({
        phase: PtcExecutionPhase.Run,
        cause: enhancePtcError(cause, scriptPath, userCode),
      }),
    }).pipe(
      Effect.timeoutFail({
        duration: MAX_TIMEOUT_MS,
        onTimeout: () => new PtcExecutionError({
          phase: PtcExecutionPhase.Run,
          cause: enhancePtcError(new Error(formatTimeoutDetail(bridge)), scriptPath, userCode),
        }),
      }),
      Effect.ensuring(Effect.sync(() => {
        signal?.removeEventListener("abort", abortNested);
        nestedController.abort(new Error("PTC execution scope closed"));
        bridge?.dispose();
      })),
    );
  }
}

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
    "async function __user_main() {",
    indented,
    "}",
    "",
    "// --- execution harness ---",
    "//# sourceURL=ptc-user-script.ts",
    "__user_main()",
    "  .then((result) => {",
    "    const out = result !== undefined && result !== null ? String(result) : '';",
    `    process.stdout.write(JSON.stringify({ type: 'complete', output: out }) + '\\n');`,
    "    process.exit(0);",
    "  })",
    "  .catch((e) => {",
    "    const msg = e instanceof Error ? e.message : String(e);",
    "    const stack = e instanceof Error ? e.stack : undefined;",
    `    process.stdout.write(JSON.stringify({ type: 'error', message: msg, stack }) + '\\n');`,
    "    process.exit(1);",
    "  });",
  ].join("\n");
}

function transformSubprocessCode(code: string): string {
  return transformSync(code, {
    loader: "ts",
    format: "esm",
    target: "node22.19",
    sourcemap: "inline",
  }).code;
}

function formatTimeoutDetail(bridge: RpcBridge | undefined): string {
  const calls = bridge?.getToolCallCount() ?? 0;
  const lastCall = bridge?.getLastToolCallLabel();
  return [
    `PTC timed out after ${Math.round(MAX_TIMEOUT_MS / 1000)}s`,
    `Completed nested tool calls: ${calls}`,
    ...(lastCall ? [`Last call: ${lastCall}`] : []),
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

function enhancePtcError(err: unknown, scriptPath: string, userCode: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? "" : "";
  const mapped = mapGeneratedStackToUserLine(scriptPath, message, stack, findUserCodeStartLine());
  if (!mapped) return err instanceof Error ? err : new Error(message);

  const snippet = buildCodeFrame(userCode, mapped.userLine);
  const enriched = [
    `PTC script error at line ${mapped.userLine}${mapped.column ? `:${mapped.column}` : ""}`,
    `Reason: ${message}`,
    "",
    snippet,
  ].join("\n");
  const out = new Error(enriched);
  out.stack = stack;
  return out;
}

function findUserCodeStartLine(): number {
  return 8;
}
