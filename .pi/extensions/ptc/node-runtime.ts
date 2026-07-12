/**
 * @module ptc/node-runtime
 * @purpose Effect wrappers around the Node IO used by the PTC executor.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { generateId } from "../_shared/id";
import { resolveNodeCommand } from "../../../src/process/platform.js";

export const PtcExecutionPhase = {
  Prepare: "prepare",
  Run: "run",
  Cleanup: "cleanup",
} as const;
export type PtcExecutionPhase = typeof PtcExecutionPhase[keyof typeof PtcExecutionPhase];

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
}

const defaultRuntime: PtcNodeRuntime = {
  tmpdir,
  writeFile: writeFileSync,
  unlink: unlinkSync,
};

export const resolvePtcNodeCommand = resolveNodeCommand;

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
