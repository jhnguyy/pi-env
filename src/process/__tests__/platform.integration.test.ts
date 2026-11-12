import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Fiber, Result } from "effect";
import { describe, expect, it, live } from "@effect/vitest";
import { onTestFinished } from "vitest";
import { ProcessFailureKind, resolveNodeCommand, runProcess, streamProcess } from "../platform";
import * as TempDir from "../../testing/temp-dir";

const node = resolveNodeCommand();

async function eventually(assertion: () => void, attempts = 40): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("process platform streamProcess", () => {
  it("captures normal stdout/stderr exit", async () => {
    const out = await Effect.runPromise(
      streamProcess(node, ["-e", "console.log('ok'); console.error('warn')"], { timeoutMs: 5_000 }),
    );
    expect(out.stdout.trim()).toBe("ok");
    expect(out.stderr.trim()).toBe("warn");
  });

  it.runIf(process.platform !== "win32").each(["run", "stream"])(
    "reports early stdin closure as a typed failure for %s without crashing its caller",
    async (mode) => {
      const result = await Effect.runPromise(
        runProcess(
          node,
          [fileURLToPath(new URL("./fixtures/stdin-failure.ts", import.meta.url)), mode],
          { timeoutMs: 10_000 },
        ),
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "exit\n", stderr: "" });
    },
  );

  it("delivers stdin to a consuming child", async () => {
    const result = await Effect.runPromise(
      runProcess(node, ["-e", "process.stdin.pipe(process.stdout)"], {
        stdin: "accepted",
        timeoutMs: 5_000,
      }),
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "accepted", stderr: "" });
  });

  it("maps spawn errors", async () => {
    const result = await Effect.runPromise(
      Effect.result(streamProcess("/definitely/missing/pi-env-cmd", [], { timeoutMs: 1_000 })),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.kind).toBe(ProcessFailureKind.Spawn);
  });

  it("maps nonzero exit and retains output", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        streamProcess(node, ["-e", "console.log('partial'); process.exit(7)"], {
          timeoutMs: 5_000,
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.kind).toBe(ProcessFailureKind.Exit);
      expect(result.failure.exitCode).toBe(7);
      expect(result.failure.stdout?.trim()).toBe("partial");
    }
  });

  it("runProcess preserves nonzero exit, stdout, and stderr as data", async () => {
    const result = await Effect.runPromise(
      runProcess(node, ["-e", "console.log('partial'); console.error('warn'); process.exit(7)"], {
        timeoutMs: 5_000,
      }),
    );
    expect(result).toMatchObject({ exitCode: 7, stdout: "partial\n", stderr: "warn\n" });
  });

  it.runIf(process.platform !== "win32")(
    "runProcess treats self-signal termination as signal-aware exit failure",
    async () => {
      const result = await Effect.runPromise(
        Effect.result(
          runProcess(node, ["-e", "process.kill(process.pid, 'SIGTERM')"], { timeoutMs: 5_000 }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.kind).toBe(ProcessFailureKind.Exit);
        expect(result.failure.message).toContain("Process exited with code unknown (SIGTERM)");
      }
    },
  );

  it("reports a timeout with captured partial output", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        streamProcess(
          node,
          ["-e", "process.stdout.write('before\\n'); setInterval(()=>{}, 1000)"],
          { timeoutMs: 500, killGraceMs: 50 },
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.kind).toBe(ProcessFailureKind.Timeout);
      expect(result.failure.stdout).toContain("before");
    }
  });

  it("enforces a combined budget without changing per-stream defaults", async () => {
    const args = ["-e", "process.stdout.write('abc'); process.stderr.write('def')"];
    const ordinary = await Effect.runPromise(runProcess(node, args, { maxBuffer: 4 }));
    expect(ordinary).toMatchObject({ stdout: "abc", stderr: "def" });
    const exact = await Effect.runPromise(
      runProcess(node, args, { maxBuffer: 4, combinedOutputLimitBytes: 6 }),
    );
    expect(exact).toMatchObject({ stdout: "abc", stderr: "def", exitCode: 0 });
    const overflow = await Effect.runPromise(
      Effect.result(
        runProcess(node, args, {
          maxBuffer: 4,
          combinedOutputLimitBytes: 4,
        }),
      ),
    );
    expect(Result.isFailure(overflow)).toBe(true);
    if (Result.isFailure(overflow)) {
      expect(overflow.failure.kind).toBe(ProcessFailureKind.OutputLimit);
      expect(overflow.failure.message).toContain("combined output");
      expect(
        Buffer.byteLength(overflow.failure.stdout ?? "") +
          Buffer.byteLength(overflow.failure.stderr ?? ""),
      ).toBe(4);
    }
  });

  it("rejects nonempty output with a zero combined budget", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        runProcess(node, ["-e", "process.stdout.write('abc')"], {
          combinedOutputLimitBytes: 0,
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.kind).toBe(ProcessFailureKind.OutputLimit);
      expect(
        Buffer.byteLength(result.failure.stdout ?? "") +
          Buffer.byteLength(result.failure.stderr ?? ""),
      ).toBe(0);
    }
  });

  it.runIf(process.platform !== "win32")(
    "awaits process-tree cleanup before rejecting combined overflow",
    async () => {
      const root = TempDir.forTestSync("pi-process-overflow-");
      const pidPaths = [join(root, "parent.pid"), join(root, "child.pid")];
      const controller = new AbortController();
      const running = Effect.runPromise(
        runProcess(
          node,
          [
            fileURLToPath(new URL("./fixtures/command-tree.ts", import.meta.url)),
            ...pidPaths,
            "overflow",
          ],
          { cwd: root, combinedOutputLimitBytes: 4, timeoutMs: 10_000 },
        ),
        { signal: controller.signal },
      );
      onTestFinished(async () => {
        controller.abort();
        await running.catch(() => {});
        // The fixture's independent watchdog bounds leaks even if process cleanup regresses.
        await eventually(() => {
          for (const path of pidPaths) {
            if (existsSync(path)) expect(isAlive(Number(readFileSync(path, "utf8")))).toBe(false);
          }
        }, 400);
        for (const path of pidPaths) expect(existsSync(`${path}.watchdog`)).toBe(false);
      });
      await expect(running).rejects.toMatchObject({ kind: ProcessFailureKind.OutputLimit });
      for (const path of pidPaths) expect(isAlive(Number(readFileSync(path, "utf8")))).toBe(false);
    },
    15_000,
  );

  it("accepts empty output with a zero combined budget", async () => {
    const empty = await Effect.runPromise(
      runProcess(node, ["-e", ""], { combinedOutputLimitBytes: 0 }),
    );
    expect(empty).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("enforces stdout and stderr byte caps with partial ASCII output", async () => {
    const stdoutResult = await Effect.runPromise(
      Effect.result(
        streamProcess(node, ["-e", "process.stdout.write('abcdef')"], {
          stdoutLimitBytes: 3,
          timeoutMs: 5_000,
        }),
      ),
    );
    expect(Result.isFailure(stdoutResult)).toBe(true);
    if (Result.isFailure(stdoutResult)) {
      expect(stdoutResult.failure.kind).toBe(ProcessFailureKind.OutputLimit);
      expect(Buffer.byteLength(stdoutResult.failure.stdout ?? "")).toBe(3);
      expect(stdoutResult.failure.stdout).toBe("abc");
    }
    const stderrResult = await Effect.runPromise(
      Effect.result(
        streamProcess(node, ["-e", "process.stderr.write('abcdef')"], {
          stderrLimitBytes: 2,
          timeoutMs: 5_000,
        }),
      ),
    );
    expect(Result.isFailure(stderrResult)).toBe(true);
    if (Result.isFailure(stderrResult)) {
      expect(stderrResult.failure.kind).toBe(ProcessFailureKind.OutputLimit);
      expect(Buffer.byteLength(stderrResult.failure.stderr ?? "")).toBe(2);
      expect(stderrResult.failure.stderr).toBe("ab");
    }
  });

  it.each([
    { name: "interrupts and awaits child cleanup", ignoreTerm: false },
    { name: "escalates interruption of a ready SIGTERM-ignoring process", ignoreTerm: true },
  ])(
    "$name",
    async ({ ignoreTerm }) => {
      const directory = TempDir.forTestSync("pi-process-interrupt-");
      let fiber: Fiber.Fiber<unknown, unknown> | undefined;
      onTestFinished(async () => {
        if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
      });
      const pidFile = join(directory, "pid");
      const script = `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ""}require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000)`;
      fiber = Effect.runFork(
        streamProcess(node, ["-e", script], { timeoutMs: 15_000, killGraceMs: 50 }),
      );
      await eventually(() => expect(existsSync(pidFile)).toBe(true), 200);
      const pid = Number(readFileSync(pidFile, "utf8"));

      await Effect.runPromise(Fiber.interrupt(fiber));

      await eventually(() => expect(isAlive(pid)).toBe(false), 200);
    },
    15_000,
  );

  live.runIf(process.platform !== "win32")(
    "terminates a ready TERM-ignoring POSIX descendant after its parent closes",
    () =>
      Effect.gen(function* () {
        const directory = TempDir.forTestSync("pi-process-tree-");
        const marker = join(directory, "marker");
        const childPidFile = join(directory, "child-pid");
        const script = join(directory, "parent.mjs");
        const childCode = [
          "const fs=require('fs')",
          "process.on('SIGTERM',()=>{})",
          `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid))`,
          `setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 25)`,
        ].join(";");
        writeFileSync(
          script,
          `import { spawn } from 'node:child_process';\nspawn(${JSON.stringify(node)}, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });\nsetInterval(()=>{}, 1000);\n`,
        );

        const fiber = yield* streamProcess(node, [script], {
          timeoutMs: 10_000,
          killGraceMs: 100,
        }).pipe(Effect.forkScoped);
        // Startup is not the termination contract. Wait for a real heartbeat before interrupting.
        yield* Effect.promise(() =>
          eventually(() => expect(readFileSync(marker, "utf8")).not.toBe(""), 200),
        );
        const childPid = Number(readFileSync(childPidFile, "utf8"));

        yield* Fiber.interrupt(fiber);

        yield* Effect.promise(() => eventually(() => expect(isAlive(childPid)).toBe(false)));
        const before = readFileSync(marker, "utf8");
        yield* Effect.sleep("100 millis");
        expect(readFileSync(marker, "utf8")).toBe(before);
      }),
    10_000,
  );
});
