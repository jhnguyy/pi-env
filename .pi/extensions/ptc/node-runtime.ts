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
import {
  PtcFailureClass,
  type PtcRunDetails,
} from "./execution-details";
import type { PtcToolFailure } from "./types";

export const PtcExecutionPhase = {
  Prepare: "prepare",
  Transform: "transform",
  Protocol: "protocol",
  Run: "run",
  Cleanup: "cleanup",
} as const;
export type PtcExecutionPhase = (typeof PtcExecutionPhase)[keyof typeof PtcExecutionPhase];

export class PtcExecutionError extends Data.TaggedError("PtcExecutionError")<{
  readonly phase: PtcExecutionPhase;
  readonly failureClass: PtcFailureClass;
  readonly cause: unknown;
  readonly details?: PtcRunDetails;
}> {
  override get message(): string {
    const reason = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `PTC ${this.phase} failed: ${reason}`;
  }
}

export class PtcProtocolError extends Data.TaggedError("PtcProtocolError")<{
  readonly reason: string;
}> {
  override get message(): string {
    return `PTC RPC protocol error: ${this.reason}`;
  }
}

export class PtcSubprocessError extends Error {
  readonly failure?: PtcToolFailure;
  readonly partialOutput: string;

  constructor(options: {
    message: string;
    stack?: string;
    failure?: PtcToolFailure;
    partialOutput?: string;
  }) {
    super(options.message);
    this.name = "PtcSubprocessError";
    if (options.stack) this.stack = options.stack;
    this.failure = options.failure;
    this.partialOutput = options.partialOutput ?? "";
  }
}

export class PtcCancellationError extends Error {
  constructor(message = "PTC execution cancelled") {
    super(message);
    this.name = "PtcCancellationError";
  }
}

export class PtcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtcTimeoutError";
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
    catch: (cause) =>
      new PtcExecutionError({
        phase: PtcExecutionPhase.Prepare,
        failureClass: PtcFailureClass.Preparation,
        cause,
      }),
  });
}

export function cleanupTempScript(
  path: string,
  runtime: PtcNodeRuntime = defaultRuntime,
): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      runtime.unlink(path);
    } catch {
      /* best-effort cleanup */
    }
  });
}
