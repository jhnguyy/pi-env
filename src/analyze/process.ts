import { spawn, type ChildProcess } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import { ProcessError, ProcessErrorKind } from "./model.js";

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 120_000 as const;
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 30_000 as const;

export interface ProcessOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number }
export interface StreamProcessOptions extends ProcessOptions { stdin?: string; stdoutLimitBytes?: number; stderrLimitBytes?: number }
export interface ProcessOutput { stdout: string; stderr: string }

const DEFAULT_STREAM_LIMIT_BYTES = 20 * 1024 * 1024;

/** Streams bounded output and waits for child exit during timeout, limit, and interruption cleanup. */
export function streamProcessEffect(command: string, args: readonly string[], options: StreamProcessOptions = {}): Effect.Effect<ProcessOutput, ProcessError> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return Effect.fail(new ProcessError({ kind: ProcessErrorKind.Spawn, command, message: "timeoutMs must be a positive integer" }));
  const stdoutLimit = options.stdoutLimitBytes ?? options.maxBuffer ?? DEFAULT_STREAM_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? options.maxBuffer ?? DEFAULT_STREAM_LIMIT_BYTES;
  if (!Number.isInteger(stdoutLimit) || stdoutLimit < 0 || !Number.isInteger(stderrLimit) || stderrLimit < 0) {
    return Effect.fail(new ProcessError({ kind: ProcessErrorKind.Spawn, command, message: "stream output limits must be non-negative integers" }));
  }

  return Effect.async<ProcessOutput, ProcessError>((resume) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let child: ChildProcess | undefined;
    let closed = false;
    let completed = false;
    let terminalError: ProcessError | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const output = (): ProcessOutput => ({ stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"), stderr: Buffer.concat(stderr, stderrBytes).toString("utf8") });
    const complete = (effect: Effect.Effect<ProcessOutput, ProcessError>): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resume(effect);
    };
    const terminate = (immediate = false): void => {
      if (child === undefined || closed) return;
      child.kill(immediate ? "SIGKILL" : "SIGTERM");
      if (!immediate) {
        killTimer = setTimeout(() => child?.kill("SIGKILL"), 1_000);
        killTimer.unref();
      }
    };
    const failAndTerminate = (error: ProcessError): void => {
      if (terminalError !== undefined || completed) return;
      terminalError = error;
      terminate();
    };
    const timeoutTimer = setTimeout(() => failAndTerminate(new ProcessError({
      kind: ProcessErrorKind.Timeout,
      command,
      message: `Process timed out after ${timeoutMs}ms: ${command}`,
      ...output(),
    })), timeoutMs);

    try {
      child = spawn(command, [...args], { cwd: options.cwd, env: options.env, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        if (terminalError !== undefined || completed) return;
        const chunks = stream === "stdout" ? stdout : stderr;
        const current = stream === "stdout" ? stdoutBytes : stderrBytes;
        const limit = stream === "stdout" ? stdoutLimit : stderrLimit;
        const remaining = Math.max(0, limit - current);
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        if (stream === "stdout") stdoutBytes += Math.min(chunk.length, remaining);
        else stderrBytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) failAndTerminate(new ProcessError({ kind: ProcessErrorKind.OutputLimit, command, message: `${stream} exceeded ${limit} bytes`, ...output() }));
      };
      child.stdout!.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr!.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.on("error", (cause) => {
        terminalError ??= new ProcessError({ kind: ProcessErrorKind.Spawn, command, message: cause.message, ...output() });
      });
      child.on("close", (code, closeSignal) => {
        closed = true;
        const value = output();
        if (terminalError !== undefined) complete(Effect.fail(new ProcessError({ ...terminalError, ...value })));
        else if (code !== 0) complete(Effect.fail(new ProcessError({ kind: ProcessErrorKind.Exit, command, message: `Process exited with code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}: ${command}`, exitCode: code ?? undefined, ...value })));
        else complete(Effect.succeed(value));
      });
      if (options.stdin !== undefined) child.stdin!.end(options.stdin);
    } catch (cause) {
      complete(Effect.fail(new ProcessError({ kind: ProcessErrorKind.Spawn, command, message: cause instanceof Error ? cause.message : String(cause), ...output() })));
    }

    return Effect.promise(() => new Promise<void>((resolve) => {
      if (closed || child === undefined) { resolve(); return; }
      child.once("close", () => resolve());
      terminalError = new ProcessError({ kind: ProcessErrorKind.Interrupted, command, message: `Process interrupted: ${command}`, ...output() });
      terminate(true);
    }));
  });
}

/** The single cross-module seam for bounded, cancellable subprocess execution. */
export class ProcessService extends Context.Tag("pi/analyze/ProcessService")<
  ProcessService,
  { readonly run: typeof streamProcessEffect }
>() {}

export const ProcessServiceLive = Layer.succeed(ProcessService, { run: streamProcessEffect });

/** Builds the service layer used by engine compatibility seams and tests. */
export const processServiceLayer = (run: typeof streamProcessEffect = streamProcessEffect) =>
  Layer.succeed(ProcessService, { run });

/** Leaves parent/headroom space and never grants an analyzer more than 1 GiB. */
export function childHeapLimitMb(maxMemoryMb: number, parentRssBytes: number): number {
  const remaining = maxMemoryMb - Math.ceil(parentRssBytes / 1024 / 1024) - 512;
  return Math.max(64, Math.min(1024, Math.floor(remaining)));
}

export function nodeAnalyzerEnvironment(maxMemoryMb: number, env: NodeJS.ProcessEnv = process.env, parentRssBytes = process.memoryUsage().rss): NodeJS.ProcessEnv {
  const prior = env.NODE_OPTIONS?.trim();
  return { ...env, NODE_OPTIONS: [prior, `--max-old-space-size=${childHeapLimitMb(maxMemoryMb, parentRssBytes)}`].filter(Boolean).join(" ") };
}
