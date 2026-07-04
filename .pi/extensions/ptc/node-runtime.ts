/**
 * @module ptc/node-runtime
 * @purpose Effect wrappers around the Node IO used by the PTC executor.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { generateId } from "../_shared/id";
import { buildSubprocessEnv } from "./types";

export enum PtcExecutionPhase {
  Prepare = "prepare",
  Run = "run",
  Cleanup = "cleanup",
}

export class PtcExecutionError extends Data.TaggedError("PtcExecutionError")<{
  readonly phase: PtcExecutionPhase;
  readonly cause: unknown;
}> {
  override get message(): string {
    const reason = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `PTC ${this.phase} failed: ${reason}`;
  }
}

export interface PtcNodeRuntime {
  tmpdir(): string;
  writeFile(path: string, data: string, options: { encoding: "utf-8"; mode: number }): void;
  unlink(path: string): void;
  spawn(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess;
}

const defaultRuntime: PtcNodeRuntime = {
  tmpdir,
  writeFile: writeFileSync,
  unlink: unlinkSync,
  spawn,
};

export function createTempScript(
  code: string,
  runtime: PtcNodeRuntime = defaultRuntime,
): Effect.Effect<string, PtcExecutionError> {
  return Effect.try({
    try: () => {
      const tmpPath = join(runtime.tmpdir(), `ptc-${generateId(8)}.mjs`);
      runtime.writeFile(tmpPath, code, { encoding: "utf-8", mode: 0o600 });
      return tmpPath;
    },
    catch: (cause) => new PtcExecutionError({ phase: PtcExecutionPhase.Prepare, cause }),
  });
}

export function cleanupTempScript(path: string, runtime: PtcNodeRuntime = defaultRuntime): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      runtime.unlink(path);
    } catch {
      /* best-effort cleanup */
    }
  });
}

export function spawnSubprocess(
  scriptPath: string,
  cwd: string,
  runtime: PtcNodeRuntime = defaultRuntime,
): Effect.Effect<ChildProcess, PtcExecutionError> {
  return Effect.try({
    try: () => runtime.spawn(process.execPath, [scriptPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: buildSubprocessEnv(),
    }),
    catch: (cause) => new PtcExecutionError({ phase: PtcExecutionPhase.Run, cause }),
  });
}
