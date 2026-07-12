import { Context, Effect, Layer } from "effect";
import { ProcessError, ProcessErrorKind } from "./model.js";
import {
  DEFAULT_BENCHMARK_TIMEOUT_MS,
  DEFAULT_EXTERNAL_TIMEOUT_MS,
  DEFAULT_STREAM_LIMIT_BYTES,
  ProcessFailure,
  ProcessFailureKind,
  streamProcess,
  type ProcessOutput,
  type StreamProcessOptions,
} from "../process/platform.js";

export { DEFAULT_BENCHMARK_TIMEOUT_MS, DEFAULT_EXTERNAL_TIMEOUT_MS, DEFAULT_STREAM_LIMIT_BYTES };
export type { ProcessOutput, StreamProcessOptions };

function toAnalyzeProcessError(error: ProcessFailure): ProcessError {
  const kind = {
    [ProcessFailureKind.Spawn]: ProcessErrorKind.Spawn,
    [ProcessFailureKind.Exit]: ProcessErrorKind.Exit,
    [ProcessFailureKind.Timeout]: ProcessErrorKind.Timeout,
    [ProcessFailureKind.OutputLimit]: ProcessErrorKind.OutputLimit,
    [ProcessFailureKind.Interrupted]: ProcessErrorKind.Interrupted,
  }[error.kind];
  return new ProcessError({
    kind,
    command: error.command,
    message: error.message,
    exitCode: error.exitCode,
    stdout: error.stdout,
    stderr: error.stderr,
  });
}

/** Analyzer compatibility adapter for the repository-wide process platform. */
export function streamProcessEffect(command: string, args: readonly string[], options: StreamProcessOptions = {}): Effect.Effect<ProcessOutput, ProcessError> {
  return streamProcess(command, args, options).pipe(Effect.mapError(toAnalyzeProcessError));
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
