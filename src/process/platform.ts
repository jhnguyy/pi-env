import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Data, Effect } from "effect";
import type { Scope } from "effect/Scope";

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 120_000 as const;
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 30_000 as const;
export const DEFAULT_STREAM_LIMIT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 1_000 as const;

export const ProcessFailureKind = {
  Spawn: "spawn",
  Exit: "exit",
  Timeout: "timeout",
  OutputLimit: "output-limit",
  Interrupted: "interrupted",
} as const;
export type ProcessFailureKind = typeof ProcessFailureKind[keyof typeof ProcessFailureKind];

export class ProcessFailure extends Data.TaggedError("ProcessFailure")<{
  readonly kind: ProcessFailureKind;
  readonly command: string;
  readonly message: string;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}> {}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly killGraceMs?: number;
}
export interface StreamProcessOptions extends ProcessOptions {
  readonly stdin?: string;
  readonly stdoutLimitBytes?: number;
  readonly stderrLimitBytes?: number;
}
export interface ScopedChildProcessOptions extends ProcessOptions {
  readonly stdio?: SpawnOptions["stdio"];
}
export interface ProcessOutput { readonly stdout: string; readonly stderr: string }

export function resolveNodeCommand(
  env: Partial<Pick<NodeJS.ProcessEnv, "PI_ENV_NODE_BIN">> = process.env,
  execPath = process.execPath,
): string {
  const configured = env.PI_ENV_NODE_BIN?.trim();
  return configured ? configured : execPath;
}

function validatePositiveInteger(value: number, name: string, command: string): ProcessFailure | undefined {
  return Number.isInteger(value) && value > 0
    ? undefined
    : new ProcessFailure({ kind: ProcessFailureKind.Spawn, command, message: `${name} must be a positive integer` });
}

function validateNonNegativeInteger(value: number, name: string, command: string): ProcessFailure | undefined {
  return Number.isInteger(value) && value >= 0
    ? undefined
    : new ProcessFailure({ kind: ProcessFailureKind.Spawn, command, message: `${name} must be a non-negative integer` });
}

function spawnOptions(options: ScopedChildProcessOptions | StreamProcessOptions, stdio: SpawnOptions["stdio"]): SpawnOptions {
  return {
    cwd: options.cwd,
    env: options.env,
    stdio,
    detached: process.platform !== "win32",
  };
}

function directChildIsOpen(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

/** Signal the POSIX process group when available, with a direct-child fallback. */
function signalChildTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && proc.pid !== undefined && proc.pid > 0 && proc.pid !== process.pid) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // The group may already be gone; a live direct child still gets a fallback signal.
    }
  }
  if (!directChildIsOpen(proc)) return;
  try { proc.kill(signal); } catch { /* already gone */ }
}

function waitForClose(proc: ChildProcess): Promise<void> {
  if (!directChildIsOpen(proc)) return Promise.resolve();
  return new Promise((resolve) => proc.once("close", () => resolve()));
}

/** TERM the tree, escalate after the grace period, and do not return before the direct child closes. */
export async function terminateAndWait(proc: ChildProcess, graceMs: number = DEFAULT_KILL_GRACE_MS): Promise<void> {
  if (!directChildIsOpen(proc)) {
    // A cooperative parent may exit before descendants. Clean the still-owned
    // POSIX group during immediate scope release; Windows has no group fallback.
    if (process.platform !== "win32") signalChildTree(proc, "SIGKILL");
    return;
  }
  const closed = waitForClose(proc);
  let graceTimer: NodeJS.Timeout | undefined;
  const graceElapsed = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, graceMs);
    graceTimer.unref();
  });

  signalChildTree(proc, "SIGTERM");
  try {
    await Promise.race([closed, graceElapsed]);
    // Always signal the POSIX group after the parent closes or grace expires so
    // TERM-ignoring descendants cannot survive a cooperative parent exit.
    signalChildTree(proc, "SIGKILL");
    await closed;
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
  }
}

function spawnStarted(
  command: string,
  args: readonly string[],
  options: ScopedChildProcessOptions,
): Effect.Effect<ChildProcess, ProcessFailure> {
  return Effect.async<ChildProcess, ProcessFailure>((resume) => {
    let proc: ChildProcess;
    let settled = false;
    const finish = (effect: Effect.Effect<ChildProcess, ProcessFailure>): void => {
      if (settled) return;
      settled = true;
      proc?.off("spawn", onSpawn);
      proc?.off("error", onError);
      resume(effect);
    };
    const onSpawn = (): void => finish(Effect.succeed(proc));
    const onError = (cause: Error): void => finish(Effect.fail(new ProcessFailure({
      kind: ProcessFailureKind.Spawn,
      command,
      message: cause.message,
    })));

    try {
      proc = spawn(command, [...args], spawnOptions(options, options.stdio ?? ["pipe", "pipe", "pipe"]));
      proc.once("spawn", onSpawn);
      proc.once("error", onError);
    } catch (cause) {
      resume(Effect.fail(new ProcessFailure({
        kind: ProcessFailureKind.Spawn,
        command,
        message: cause instanceof Error ? cause.message : String(cause),
      })));
      return;
    }

    return Effect.promise(async () => {
      proc.off("spawn", onSpawn);
      proc.off("error", onError);
      if (!settled) await terminateAndWait(proc, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    });
  });
}

export function scopedChildProcess(
  command: string,
  args: readonly string[],
  options: ScopedChildProcessOptions = {},
): Effect.Effect<ChildProcess, ProcessFailure, Scope> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const invalid = validatePositiveInteger(timeoutMs, "timeoutMs", command)
    ?? validateNonNegativeInteger(killGraceMs, "killGraceMs", command);
  if (invalid) return Effect.fail(invalid);
  return Effect.acquireRelease(
    spawnStarted(command, args, options),
    (proc) => Effect.promise(() => terminateAndWait(proc, killGraceMs)),
  );
}

/** Streams bounded output and waits for child-tree cleanup on timeout, limit, or interruption. */
export function streamProcess(
  command: string,
  args: readonly string[],
  options: StreamProcessOptions = {},
): Effect.Effect<ProcessOutput, ProcessFailure> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const stdoutLimit = options.stdoutLimitBytes ?? options.maxBuffer ?? DEFAULT_STREAM_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? options.maxBuffer ?? DEFAULT_STREAM_LIMIT_BYTES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const invalid = validatePositiveInteger(timeoutMs, "timeoutMs", command)
    ?? validateNonNegativeInteger(stdoutLimit, "stdoutLimitBytes", command)
    ?? validateNonNegativeInteger(stderrLimit, "stderrLimitBytes", command)
    ?? validateNonNegativeInteger(killGraceMs, "killGraceMs", command);
  if (invalid) return Effect.fail(invalid);

  return Effect.async<ProcessOutput, ProcessFailure>((resume) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let child: ChildProcess | undefined;
    let settled = false;
    let closed = false;
    let terminalError: ProcessFailure | undefined;
    let termination: Promise<void> | undefined;

    const output = (): ProcessOutput => ({
      stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
      stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
    });
    const removeListeners = (): void => {
      child?.stdout?.off("data", onStdout);
      child?.stderr?.off("data", onStderr);
      child?.off("error", onError);
      child?.off("close", onClose);
    };
    const settle = (effect: Effect.Effect<ProcessOutput, ProcessFailure>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      removeListeners();
      resume(effect);
    };
    const beginTermination = (): Promise<void> => {
      if (termination) return termination;
      if (!child || closed) return Promise.resolve();
      termination = terminateAndWait(child, killGraceMs);
      return termination;
    };
    const failAndTerminate = (error: ProcessFailure): void => {
      if (terminalError || settled) return;
      terminalError = error;
      void beginTermination();
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (terminalError || settled) return;
      const chunks = stream === "stdout" ? stdout : stderr;
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const limit = stream === "stdout" ? stdoutLimit : stderrLimit;
      const remaining = Math.max(0, limit - current);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += Math.min(chunk.length, remaining);
      else stderrBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) {
        failAndTerminate(new ProcessFailure({
          kind: ProcessFailureKind.OutputLimit,
          command,
          message: `${stream} exceeded ${limit} bytes`,
          ...output(),
        }));
      }
    };
    const onStdout = (chunk: Buffer): void => collect("stdout", chunk);
    const onStderr = (chunk: Buffer): void => collect("stderr", chunk);
    const onError = (cause: Error): void => failAndTerminate(new ProcessFailure({
      kind: ProcessFailureKind.Spawn,
      command,
      message: cause.message,
      ...output(),
    }));
    const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
      closed = true;
      const value = output();
      if (terminalError) {
        void (termination ?? Promise.resolve()).then(() => settle(Effect.fail(new ProcessFailure({ ...terminalError!, ...value }))));
      } else if (code !== 0) {
        settle(Effect.fail(new ProcessFailure({
          kind: ProcessFailureKind.Exit,
          command,
          message: `Process exited with code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}: ${command}`,
          exitCode: code ?? undefined,
          ...value,
        })));
      } else {
        settle(Effect.succeed(value));
      }
    };

    const timeoutTimer = setTimeout(() => failAndTerminate(new ProcessFailure({
      kind: ProcessFailureKind.Timeout,
      command,
      message: `Process timed out after ${timeoutMs}ms: ${command}`,
      ...output(),
    })), timeoutMs);
    timeoutTimer.unref();

    try {
      child = spawn(command, [...args], spawnOptions(options, [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]));
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onClose);
      if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    } catch (cause) {
      settle(Effect.fail(new ProcessFailure({
        kind: ProcessFailureKind.Spawn,
        command,
        message: cause instanceof Error ? cause.message : String(cause),
        ...output(),
      })));
    }

    return Effect.promise(async () => {
      if (!settled) {
        terminalError ??= new ProcessFailure({
          kind: ProcessFailureKind.Interrupted,
          command,
          message: `Process interrupted: ${command}`,
          ...output(),
        });
        await beginTermination();
      }
      clearTimeout(timeoutTimer);
      removeListeners();
    });
  });
}
