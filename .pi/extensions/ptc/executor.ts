/**
 * @module ptc/executor
 * @purpose Orchestrates PTC subprocess execution.
 */

import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transformSync, type Message } from "esbuild";
import { Cause, Effect } from "effect";
import type {
  ExtensionContext,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { buildCodeFrame, mapGeneratedStackToUserLine } from "../_shared/code-frame";
import { RpcBridge } from "./rpc-bridge";
import { generateRuntimeBindings } from "./wrapper-gen";
import type { ToolRegistry } from "./tool-registry";
import { scopedChildProcess } from "../../../src/process/platform.js";
import { MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES, buildSubprocessEnv } from "./types";
import {
  PtcCompletion,
  PtcExecutionTracker,
  PtcFailureClass,
  type PtcRunDetails,
} from "./execution-details";
import {
  createTempScript,
  cleanupTempScript,
  resolvePtcNodeCommand,
  PtcCancellationError,
  PtcExecutionError,
  PtcExecutionPhase,
  PtcProtocolError,
  PtcSubprocessError,
  PtcTimeoutError,
} from "./node-runtime";

const PREAMBLE_PATH = fileURLToPath(new URL("./subprocess-preamble.js", import.meta.url));
const PTC_SOURCE_NAME = "ptc-user-script.ts";

interface SubprocessSource {
  readonly code: string;
  readonly userCode: string;
  readonly userStartLine: number;
}

export interface PtcExecutionResult {
  readonly output: string;
  readonly details: PtcRunDetails;
}

export type PtcExecutorRegistry = Pick<ToolRegistry, "getRuntimeSnapshot" | "dispatch">;

export class PtcExecutor {
  constructor(
    private registry: PtcExecutorRegistry,
    private preamblePath = PREAMBLE_PATH,
    private timeoutMs = MAX_TIMEOUT_MS,
  ) {}

  async execute(
    userCode: string,
    cwd: string,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionContext,
  ): Promise<PtcExecutionResult> {
    const tracker = new PtcExecutionTracker();
    try {
      const snapshot = this.registry.getRuntimeSnapshot();
      const bindings = generateRuntimeBindings(snapshot);
      const source = buildSubprocessCode(this.preamblePath, bindings, userCode);
      const output = await Effect.runPromise(
        transformSubprocessCode(source).pipe(
          Effect.flatMap((runnableCode) =>
            Effect.acquireUseRelease(
              createTempScript(runnableCode),
              (tmpPath) =>
                this.runSubprocessEffect(tmpPath, source, cwd, tracker, signal, onUpdate, ctx),
              (tmpPath) => cleanupTempScript(tmpPath),
            ),
          ),
        ),
      );
      return { output, details: tracker.details(PtcCompletion.Success) };
    } catch (cause: unknown) {
      const error =
        cause instanceof PtcExecutionError
          ? cause
          : new PtcExecutionError({
              phase: PtcExecutionPhase.Prepare,
              failureClass: PtcFailureClass.Preparation,
              cause,
            });
      throw new PtcExecutionError({
        phase: error.phase,
        failureClass: error.failureClass,
        cause: error.cause,
        details: tracker.details(PtcCompletion.Failure, error.failureClass),
      });
    }
  }

  private runSubprocessEffect(
    scriptPath: string,
    source: SubprocessSource,
    cwd: string,
    tracker: PtcExecutionTracker,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<unknown>,
    ctx?: ExtensionContext,
  ): Effect.Effect<string, PtcExecutionError> {
    return Effect.scoped(
      scopedChildProcess(resolvePtcNodeCommand(), ["--enable-source-maps", scriptPath], {
        cwd,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: buildSubprocessEnv(),
        timeoutMs: this.timeoutMs,
        killGraceMs: 5_000,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PtcExecutionError({
              phase: PtcExecutionPhase.Run,
              failureClass: PtcFailureClass.Infrastructure,
              cause,
            }),
        ),
        Effect.flatMap((proc) =>
          this.awaitSubprocessEffect(proc, source, cwd, tracker, signal, onUpdate, ctx),
        ),
      ),
    );
  }

  private awaitSubprocessEffect(
    proc: ChildProcess,
    source: SubprocessSource,
    cwd: string,
    tracker: PtcExecutionTracker,
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
        bridge = new RpcBridge(proc, dispatch, nestedController.signal, onUpdate, tracker);
        const truncated = truncateOutput(await bridge.completion);
        if (truncated.truncated) tracker.markOutputTruncated();
        return truncated.output;
      },
      catch: (cause) => {
        const failureClass = classifyRunFailure(cause);
        const enhanced = cause instanceof PtcProtocolError ? cause : enhancePtcError(cause, source);
        return new PtcExecutionError({
          phase:
            cause instanceof PtcProtocolError ? PtcExecutionPhase.Protocol : PtcExecutionPhase.Run,
          failureClass,
          cause: appendPartialOutput(enhanced, cause),
        });
      },
    }).pipe(
      Effect.timeout(this.timeoutMs),
      Effect.catchIf(Cause.isTimeoutError, () =>
        Effect.fail(
          new PtcExecutionError({
            phase: PtcExecutionPhase.Run,
            failureClass: PtcFailureClass.Timeout,
            cause: enhancePtcError(
              new PtcTimeoutError(formatTimeoutDetail(bridge, this.timeoutMs)),
              source,
            ),
          }),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          signal?.removeEventListener("abort", abortNested);
          nestedController.abort(new Error("PTC execution scope closed"));
          bridge?.dispose();
        }),
      ),
    );
  }
}

function buildSubprocessCode(
  preamblePath: string,
  bindings: string,
  userCode: string,
): SubprocessSource {
  const prefix = [
    `import { __create_tools, settle } from ${JSON.stringify(preamblePath)};`,
    "",
    "// --- tool bindings ---",
    bindings,
    "",
    "// --- user code ---",
    "async function __user_main() {",
  ].join("\n");
  const userStartLine = prefix.split("\n").length + 1;
  const suffix = [
    "}",
    "",
    "// --- execution harness ---",
    "function __bound_return_output(output) {",
    "  const totalBytes = Buffer.byteLength(output);",
    `  if (totalBytes <= ${MAX_OUTPUT_BYTES}) return { output, truncated: false };`,
    `  const marker = '\\n\\n[PTC output truncated — showing first ${MAX_OUTPUT_BYTES} bytes of ' + totalBytes + ']';`,
    `  const contentBytes = Math.max(0, ${MAX_OUTPUT_BYTES} - Buffer.byteLength(marker));`,
    "  let content = Buffer.from(output).subarray(0, contentBytes).toString('utf8');",
    "  while (Buffer.byteLength(content) > contentBytes) content = content.slice(0, -1);",
    "  return { output: content + marker, truncated: true };",
    "}",
    "",
    "__user_main()",
    "  .then(async (result) => {",
    "    const rawOutput = result !== undefined && result !== null ? String(result) : '';",
    "    const bounded = __bound_return_output(rawOutput);",
    "    await new Promise((resolve) => process.stdout.write('', resolve));",
    "    const { writeFileSync } = await import('node:fs');",
    "    writeFileSync(3, JSON.stringify({ type: 'complete', output: bounded.output, outputTruncated: bounded.truncated }) + '\\n');",
    "    process.exit(0);",
    "  })",
    "  .catch(async (e) => {",
    "    const msg = e instanceof Error ? e.message : String(e);",
    "    const stack = e instanceof Error ? e.stack : undefined;",
    "    const rawFailure = e instanceof Error && e.name === 'PtcToolCallError' ? e.failure : undefined;",
    "    const failure = rawFailure && typeof rawFailure.class === 'string' && typeof rawFailure.message === 'string' && (rawFailure.tool === undefined || typeof rawFailure.tool === 'string') ? { class: rawFailure.class, message: rawFailure.message, ...(rawFailure.tool ? { tool: rawFailure.tool } : {}) } : undefined;",
    "    await new Promise((resolve) => process.stdout.write('', resolve));",
    "    const { writeFileSync } = await import('node:fs');",
    "    writeFileSync(3, JSON.stringify({ type: 'error', message: msg, stack, ...(failure ? { failure } : {}) }) + '\\n');",
    "    process.exit(1);",
    "  });",
  ].join("\n");

  return {
    code: `${prefix}\n${userCode}\n${suffix}`,
    userCode,
    userStartLine,
  };
}

function transformSubprocessCode(
  source: SubprocessSource,
): Effect.Effect<string, PtcExecutionError> {
  return Effect.try({
    try: () =>
      transformSync(source.code, {
        loader: "ts",
        format: "esm",
        target: "node22.19",
        sourcefile: PTC_SOURCE_NAME,
        sourcemap: "inline",
        sourcesContent: true,
      }).code,
    catch: (cause) =>
      new PtcExecutionError({
        phase: PtcExecutionPhase.Transform,
        failureClass: PtcFailureClass.Transformation,
        cause: enhanceTransformError(cause, source),
      }),
  });
}

function enhanceTransformError(cause: unknown, source: SubprocessSource): Error {
  const diagnostic = firstTransformDiagnostic(cause);
  const reason = diagnostic?.text ?? (cause instanceof Error ? cause.message : String(cause));
  const location = diagnostic?.location;
  if (!location) return new Error(reason);

  const userLineCount = source.userCode.split("\n").length;
  const userLine = location.line - source.userStartLine + 1;
  if (userLine < 1 || userLine > userLineCount) return new Error(reason);

  const column = location.column + 1;
  const frame = buildCodeFrame(source.userCode, userLine);
  return new Error(
    [
      `PTC transform error at line ${userLine}${column ? `:${column}` : ""}`,
      `Reason: ${reason}`,
      "",
      frame,
    ].join("\n"),
  );
}

function firstTransformDiagnostic(cause: unknown): Message | undefined {
  if (typeof cause !== "object" || cause === null || !("errors" in cause)) return undefined;
  const errors = (cause as { errors?: unknown }).errors;
  return Array.isArray(errors) ? errors.find(isTransformMessage) : undefined;
}

function isTransformMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "text" in value;
}

function formatTimeoutDetail(bridge: RpcBridge | undefined, timeoutMs: number): string {
  const calls = bridge?.getCompletedToolCallCount() ?? 0;
  const lastCall = bridge?.getLastToolCallLabel();
  const duration = timeoutMs < 1_000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1_000)}s`;
  return [
    `PTC timed out after ${duration}`,
    `Completed nested tool calls: ${calls}`,
    ...(lastCall ? [`Last call: ${lastCall}`] : []),
  ].join("\n");
}

function truncateOutput(output: string): { output: string; truncated: boolean } {
  const result = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: MAX_OUTPUT_BYTES,
  });
  if (!result.truncated) return { output: result.content, truncated: false };
  return {
    output:
      result.content +
      `\n\n[PTC output truncated — showing first ${MAX_OUTPUT_BYTES} bytes of ${result.totalBytes}]`,
    truncated: true,
  };
}

function classifyRunFailure(cause: unknown): PtcFailureClass {
  if (cause instanceof PtcCancellationError) return PtcFailureClass.Cancellation;
  if (cause instanceof PtcSubprocessError) {
    return cause.failure ? PtcFailureClass.NestedTool : PtcFailureClass.UserScript;
  }
  return PtcFailureClass.Infrastructure;
}

function appendPartialOutput(enhanced: unknown, cause: unknown): unknown {
  if (!(cause instanceof PtcSubprocessError) || !cause.partialOutput.trim()) return enhanced;
  const partial = truncateHead(cause.partialOutput, { maxLines: 40, maxBytes: 2_000 });
  const suffix = partial.truncated ? "\n[partial output truncated]" : "";
  const message = enhanced instanceof Error ? enhanced.message : String(enhanced);
  const error = new Error(`${message}\n\nPartial output:\n${partial.content}${suffix}`);
  if (enhanced instanceof Error && enhanced.stack) error.stack = enhanced.stack;
  return error;
}

function enhancePtcError(err: unknown, source: SubprocessSource): Error {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  const mapped = mapGeneratedStackToUserLine(PTC_SOURCE_NAME, message, stack, source.userStartLine);
  const userLineCount = source.userCode.split("\n").length;
  if (!mapped || mapped.userLine > userLineCount) {
    return err instanceof Error ? err : new Error(message);
  }

  const snippet = buildCodeFrame(source.userCode, mapped.userLine);
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
