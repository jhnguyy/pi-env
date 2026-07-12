import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Result } from "effect";
import { describe, expect, it } from "vitest";
import { ProcessFailureKind, resolveNodeCommand, runProcess, streamProcess } from "../platform";

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

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("process platform streamProcess", () => {
  it("captures normal stdout/stderr exit", async () => {
    const out = await Effect.runPromise(streamProcess(node, ["-e", "console.log('ok'); console.error('warn')"], { timeoutMs: 5_000 }));
    expect(out.stdout.trim()).toBe("ok");
    expect(out.stderr.trim()).toBe("warn");
  });

  it("maps spawn errors", async () => {
    const result = await Effect.runPromise(Effect.result(streamProcess("/definitely/missing/pi-env-cmd", [], { timeoutMs: 1_000 })));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.kind).toBe(ProcessFailureKind.Spawn);
  });

  it("maps nonzero exit and retains output", async () => {
    const result = await Effect.runPromise(Effect.result(streamProcess(node, ["-e", "console.log('partial'); process.exit(7)"], { timeoutMs: 5_000 })));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.kind).toBe(ProcessFailureKind.Exit);
      expect(result.failure.exitCode).toBe(7);
      expect(result.failure.stdout?.trim()).toBe("partial");
    }
  });

  it("runProcess preserves nonzero exit, stdout, and stderr as data", async () => {
    const result = await Effect.runPromise(runProcess(node, ["-e", "console.log('partial'); console.error('warn'); process.exit(7)"], { timeoutMs: 5_000 }));
    expect(result).toMatchObject({ exitCode: 7, stdout: "partial\n", stderr: "warn\n" });
  });

  it("runProcess shares timeout failures", async () => {
    const result = await Effect.runPromise(Effect.result(runProcess(node, ["-e", "setInterval(()=>{}, 1000)"], { timeoutMs: 50, killGraceMs: 50 })));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.kind).toBe(ProcessFailureKind.Timeout);
  });

  it.runIf(process.platform !== "win32")("runProcess treats self-signal termination as signal-aware exit failure", async () => {
    const result = await Effect.runPromise(Effect.result(runProcess(node, ["-e", "process.kill(process.pid, 'SIGTERM')"], { timeoutMs: 5_000 })));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.kind).toBe(ProcessFailureKind.Exit);
      expect(result.failure.message).toContain("Process exited with code unknown (SIGTERM)");
    }
  });

  it("times out, terminates, and returns partial output", async () => {
    const result = await Effect.runPromise(Effect.result(streamProcess(node, ["-e", "process.stdout.write('before\\n'); setInterval(()=>{}, 1000)"], { timeoutMs: 500, killGraceMs: 50 })));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.kind).toBe(ProcessFailureKind.Timeout);
      expect(result.failure.stdout).toContain("before");
    }
  });

  it("enforces byte-accurate stdout and stderr caps with partial output", async () => {
    const stdoutResult = await Effect.runPromise(Effect.result(streamProcess(node, ["-e", "process.stdout.write('abcdef')"], { stdoutLimitBytes: 3, timeoutMs: 5_000 })));
    expect(Result.isFailure(stdoutResult)).toBe(true);
    if (Result.isFailure(stdoutResult)) {
      expect(stdoutResult.failure.kind).toBe(ProcessFailureKind.OutputLimit);
      expect(Buffer.byteLength(stdoutResult.failure.stdout ?? "")).toBe(3);
      expect(stdoutResult.failure.stdout).toBe("abc");
    }
    const stderrResult = await Effect.runPromise(Effect.result(streamProcess(node, ["-e", "process.stderr.write('abcdef')"], { stderrLimitBytes: 2, timeoutMs: 5_000 })));
    expect(Result.isFailure(stderrResult)).toBe(true);
    if (Result.isFailure(stderrResult)) {
      expect(stderrResult.failure.kind).toBe(ProcessFailureKind.OutputLimit);
      expect(Buffer.byteLength(stderrResult.failure.stderr ?? "")).toBe(2);
      expect(stderrResult.failure.stderr).toBe("ab");
    }
  });

  it("interrupts and awaits child cleanup", async () => {
    const directory = temporaryDirectory("pi-process-interrupt-");
    const pidFile = join(directory, "pid");
    const fiber = Effect.runFork(streamProcess(node, ["-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000)`], { timeoutMs: 5_000, killGraceMs: 50 }));
    await eventually(() => expect(existsSync(pidFile)).toBe(true), 120);
    const pid = Number(readFileSync(pidFile, "utf8"));

    await Effect.runPromise(Fiber.interrupt(fiber));

    await eventually(() => expect(isAlive(pid)).toBe(false));
    rmSync(directory, { recursive: true, force: true });
  });

  it("kills a started SIGTERM-ignoring process via escalation", async () => {
    const directory = temporaryDirectory("pi-process-kill-");
    const pidFile = join(directory, "pid");
    const result = await Effect.runPromise(Effect.result(streamProcess(node, ["-e", `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000)`], { timeoutMs: 750, killGraceMs: 50 })));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.kind).toBe(ProcessFailureKind.Timeout);
    await eventually(() => expect(isAlive(pid)).toBe(false));
    rmSync(directory, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")("terminates a started TERM-ignoring POSIX descendant after its parent closes", async () => {
    const directory = temporaryDirectory("pi-process-tree-");
    const marker = join(directory, "marker");
    const childPidFile = join(directory, "child-pid");
    const script = join(directory, "parent.mjs");
    const childCode = [
      "const fs=require('fs')",
      "process.on('SIGTERM',()=>{})",
      `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid))`,
      `setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 25)`,
    ].join(";");
    writeFileSync(script, `import { spawn } from 'node:child_process';\nspawn(${JSON.stringify(node)}, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });\nsetInterval(()=>{}, 1000);\n`);

    const result = await Effect.runPromise(Effect.result(streamProcess(node, [script], { timeoutMs: 1_000, killGraceMs: 100 })));

    expect(Result.isFailure(result)).toBe(true);
    expect(existsSync(childPidFile)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    const childPid = Number(readFileSync(childPidFile, "utf8"));
    const before = readFileSync(marker, "utf8");
    await eventually(() => expect(isAlive(childPid)).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(marker, "utf8")).toBe(before);
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("resolveNodeCommand", () => {
  it("selects PI_ENV_NODE_BIN only when nonempty", () => {
    expect(resolveNodeCommand({ PI_ENV_NODE_BIN: " /chosen/node " }, "/exec/node")).toBe("/chosen/node");
    expect(resolveNodeCommand({ PI_ENV_NODE_BIN: " " }, "/exec/node")).toBe("/exec/node");
  });
});
