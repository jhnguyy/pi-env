import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { execEffect } from "../_shared/exec";

type Exec = ExtensionAPI["exec"];

class TestError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", killed: false });
const makeError = (detail: string, cause?: unknown) => new TestError(detail, cause);

describe("shared execEffect", () => {
  it("passes default/configured cwd and timeout", async () => {
    const calls: Array<{ cwd?: string; timeout?: number }> = [];
    const exec: Exec = async (_command, _args, options) => {
      calls.push({ cwd: options?.cwd, timeout: options?.timeout });
      return ok("done");
    };

    await Effect.runPromise(execEffect(exec, "echo", ["hi"], makeError));
    await Effect.runPromise(
      execEffect(exec, "echo", ["hi"], makeError, { cwd: "/tmp/x", timeout: 42 }),
    );

    expect(calls).toEqual([
      { cwd: undefined, timeout: 120000 },
      { cwd: "/tmp/x", timeout: 42 },
    ]);
  });

  it("fails nonzero exits through the supplied typed error factory unless disabled", async () => {
    const exec: Exec = async () => ({ ...ok("out"), code: 7, stderr: "bad" });

    await expect(Effect.runPromise(execEffect(exec, "cmd", ["arg"], makeError))).rejects.toThrow(
      "cmd arg exited 7: bad",
    );
    await expect(
      Effect.runPromise(execEffect(exec, "cmd", ["arg"], makeError, { failOnNonZero: false })),
    ).resolves.toMatchObject({ code: 7 });
  });

  it("forwards Effect interruption as the exec AbortSignal", async () => {
    let signal: AbortSignal | undefined;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const exec: Exec = async (_command, _args, options) => {
      signal = options?.signal;
      start();
      return new Promise<ExecResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    };

    const fiber = Effect.runFork(execEffect(exec, "sleep", ["1"], makeError));
    await started;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(signal?.aborted).toBe(true);
  });
});
