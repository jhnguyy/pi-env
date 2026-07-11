import { execFile } from "node:child_process";
import { Effect } from "effect";
import { ProcessError, ProcessErrorKind } from "./model.js";

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 120_000 as const;
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 30_000 as const;

export interface ProcessOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number }
export interface ProcessOutput { stdout: string; stderr: string }

export function execFileEffect(command: string, args: readonly string[], options: ProcessOptions = {}): Effect.Effect<ProcessOutput, ProcessError> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return Effect.fail(new ProcessError({ kind: ProcessErrorKind.Spawn, command, message: "timeoutMs must be a positive integer" }));
  }
  return Effect.tryPromise({
    try: (signal) => new Promise<ProcessOutput>((resolve, reject) => {
      const controller = new AbortController();
      let timedOut = false;
      const interrupt = (): void => controller.abort();
      const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener("abort", interrupt); };
      signal.addEventListener("abort", interrupt, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        execFile(command, [...args], { cwd: options.cwd, env: options.env, maxBuffer: options.maxBuffer, signal: controller.signal, encoding: "utf8" }, (error, stdout, stderr) => {
          cleanup();
          if (error !== null) {
            reject(new ProcessError({ kind: timedOut ? ProcessErrorKind.Timeout : ProcessErrorKind.Exit, command, message: timedOut ? `Process timed out after ${timeoutMs}ms: ${command}` : error.message, exitCode: typeof error.code === "number" ? error.code : undefined, stdout, stderr }));
          } else resolve({ stdout, stderr });
        });
      } catch (cause) { cleanup(); reject(cause); }
    }),
    catch: (cause) => cause instanceof ProcessError ? cause : new ProcessError({ kind: ProcessErrorKind.Spawn, command, message: cause instanceof Error ? cause.message : String(cause) }),
  });
}

/** Leaves parent/headroom space and never grants an analyzer more than 1 GiB. */
export function childHeapLimitMb(maxMemoryMb: number, parentRssBytes: number): number {
  const remaining = maxMemoryMb - Math.ceil(parentRssBytes / 1024 / 1024) - 512;
  return Math.max(64, Math.min(1024, Math.floor(remaining)));
}

export function nodeAnalyzerEnvironment(maxMemoryMb: number, env: NodeJS.ProcessEnv = process.env, parentRssBytes = process.memoryUsage().rss): NodeJS.ProcessEnv {
  const prior = env.NODE_OPTIONS?.trim();
  return { ...env, NODE_OPTIONS: [prior, `--max-old-space-size=${childHeapLimitMb(maxMemoryMb, parentRssBytes)}`].filter(Boolean).join(" ") };
}
