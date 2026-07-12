import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessFailure, ProcessFailureKind, resolveNodeCommand } from "../../../../src/process/platform.js";
import { captureDiff, legacyExecJitRunner, platformJitRunner, readSourceFiles, resolveExtensionDir, resolveGitRoot, runForExtension } from "../runner";
import type { ExecResult, JitRunner } from "../runner";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = join(tmpdir(), `jit-catch-runner-${process.pid}-${tempDirs.length}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveExtensionDir", () => {
  it("resolves project-local extension directories from diff paths relative to the git root", () => {
    const root = tempRoot();
    const extDir = join(root, ".pi", "extensions", "dev-tools");
    mkdirSync(extDir, { recursive: true });

    expect(resolveExtensionDir({
      name: "dev-tools",
      changedFiles: [".pi/extensions/dev-tools/index.ts"],
    }, root)).toBe(extDir);
  });

  it("falls back to the global extension directory when the project-local path is absent", () => {
    const root = tempRoot();

    expect(resolveExtensionDir({
      name: "dev-tools",
      changedFiles: [".pi/extensions/dev-tools/index.ts"],
    }, root)).toMatch(/\.pi\/agent\/extensions\/dev-tools$/);
  });
});

describe("readSourceFiles", () => {
  it("reads changed source files from the workspace root before legacy global paths", () => {
    const root = tempRoot();
    const sourcePath = join(root, ".pi", "extensions", "dev-tools", "index.ts");
    mkdirSync(join(root, ".pi", "extensions", "dev-tools"), { recursive: true });
    writeFileSync(sourcePath, "export const source = 'workspace';\n");

    const content = readSourceFiles([".pi/extensions/dev-tools/index.ts"], root);

    expect(content).toContain("// FILE: .pi/extensions/dev-tools/index.ts");
    expect(content).toContain("export const source = 'workspace';");
  });
});

describe("resolveGitRoot", () => {
  it("uses git rev-parse output when available", async () => {
    const exec: JitRunner = () => Effect.succeed({ code: 0, stdout: "/repo/root\n", stderr: "" });

    await expect(resolveGitRoot(exec, "/repo/root/subdir")).resolves.toBe("/repo/root");
  });

  it("falls back to gitCwd when rev-parse fails", async () => {
    const exec: JitRunner = () => Effect.succeed({ code: 128, stdout: "", stderr: "not a repo" });

    await expect(resolveGitRoot(exec, "/not/repo")).resolves.toBe("/not/repo");
  });
});

describe("captureDiff", () => {
  it("returns user-facing capture-diff failures unchanged", async () => {
    const exec: JitRunner = () => Effect.succeed({ code: 1, stdout: "", stderr: "fatal: bad revision" });

    await expect(captureDiff("commit", exec, "/repo", "deadbeef")).rejects.toThrow(
      "git show failed (exit 1): fatal: bad revision",
    );
  });
});

describe("legacyExecJitRunner", () => {
  it("adapts promise exec and propagates Effect interruption through AbortSignal", async () => {
    let observedSignal: AbortSignal | undefined;
    const aborted = new Promise<void>((resolve) => {
      const runner = legacyExecJitRunner((_cmd, _args, opts) => {
        observedSignal = opts?.signal;
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        return new Promise(() => {});
      });
      const fiber = Effect.runFork(runner("cmd", [], {}));
      void Effect.runPromise(Fiber.interrupt(fiber));
    });

    await expect(aborted).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("platformJitRunner", () => {
  const node = resolveNodeCommand();

  it("returns normal nonzero exit code and output as command data", async () => {
    const result = await Effect.runPromise(platformJitRunner(node, ["-e", "console.log('out'); console.error('err'); process.exit(5)"], { timeout: 5_000 }));
    expect(result).toEqual({ code: 5, stdout: "out\n", stderr: "err\n" });
  });

  it("fails timeouts as operational ProcessFailure errors", async () => {
    const result = await Effect.runPromise(Effect.either(platformJitRunner(node, ["-e", "setInterval(()=>{}, 1000)"], { timeout: 50 })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.kind).toBe(ProcessFailureKind.Timeout);
  });

  it.runIf(process.platform !== "win32")("fails self-signal termination as operational ProcessFailure errors", async () => {
    const result = await Effect.runPromise(Effect.either(platformJitRunner(node, ["-e", "process.kill(process.pid, 'SIGTERM')"], { timeout: 5_000 })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.kind).toBe(ProcessFailureKind.Exit);
  });
});

describe("runForExtension", () => {
  function makeExtensionRoot(): { root: string; extDir: string; testPath: string } {
    const root = tempRoot();
    const extDir = join(root, ".pi", "extensions", "demo");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "index.ts"), "export const demo = true;\n");
    return { root, extDir, testPath: join(extDir, "__tests__", "demo.catching.test.ts") };
  }

  it("propagates cancellation to injected exec and keeps the generated test", async () => {
    const { root, testPath } = makeExtensionRoot();
    const controller = new AbortController();
    let signalAbortObservedResolve!: () => void;
    const signalAbortObserved = new Promise<void>((resolve) => {
      signalAbortObservedResolve = resolve;
    });

    const exec: JitRunner = (cmd, _args, _opts) => {
      if (cmd === "pi") return Effect.succeed({ code: 0, stdout: "import { describe } from 'vitest';", stderr: "" });

      setTimeout(() => controller.abort(), 0);
      return Effect.async<ExecResult, never>(() => {
        return Effect.sync(() => signalAbortObservedResolve());
      });
    };

    await expect(runForExtension(
      { name: "demo", changedFiles: [".pi/extensions/demo/index.ts"] },
      "diff --git a/.pi/extensions/demo/index.ts b/.pi/extensions/demo/index.ts",
      exec,
      controller.signal,
      root,
    )).rejects.toThrow();

    await expect(signalAbortObserved).resolves.toBeUndefined();
    expect(existsSync(testPath)).toBe(true);
  });

  it("deletes the generated catching test after a passing run", async () => {
    const { root, testPath } = makeExtensionRoot();
    const exec: JitRunner = (cmd) => Effect.succeed(cmd === "pi"
      ? { code: 0, stdout: "import { describe } from 'vitest';", stderr: "" }
      : { code: 0, stdout: "pass", stderr: "" });

    const result = await runForExtension(
      { name: "demo", changedFiles: [".pi/extensions/demo/index.ts"] },
      "diff",
      exec,
      undefined,
      root,
    );

    expect(result).toMatchObject({ passed: true, testPath: null });
    expect(existsSync(testPath)).toBe(false);
  });

  it("keeps passing runs passing when best-effort deletion fails", async () => {
    const { root, testPath } = makeExtensionRoot();
    const exec: JitRunner = (cmd) => {
      if (cmd === "pi") return Effect.succeed({ code: 0, stdout: "import { describe } from 'vitest';", stderr: "" });
      rmSync(testPath, { force: true });
      return Effect.succeed({ code: 0, stdout: "pass", stderr: "" });
    };

    const result = await runForExtension(
      { name: "demo", changedFiles: [".pi/extensions/demo/index.ts"] },
      "diff",
      exec,
      undefined,
      root,
    );

    expect(result).toMatchObject({ passed: true, testPath: null });
  });

  it("keeps generator nonzero behavior and stderr in the user-facing result", async () => {
    const { root, testPath } = makeExtensionRoot();
    const exec: JitRunner = (cmd) => Effect.succeed(cmd === "pi"
      ? { code: 2, stdout: "", stderr: "generator failed exactly" }
      : { code: 0, stdout: "pass", stderr: "" });

    const result = await runForExtension(
      { name: "demo", changedFiles: [".pi/extensions/demo/index.ts"] },
      "diff",
      exec,
      undefined,
      root,
    );

    expect(result).toMatchObject({
      passed: false,
      testPath: null,
      testOutput: "Test generation failed: Test-writer subagent failed (exit 2): generator failed exactly",
    });
    expect(existsSync(testPath)).toBe(false);
  });

  it("keeps npm nonzero as a failed-test result with retained output and file", async () => {
    const { root, testPath } = makeExtensionRoot();
    const exec: JitRunner = (cmd) => Effect.succeed(cmd === "pi"
      ? { code: 0, stdout: "import { describe } from 'vitest';", stderr: "" }
      : { code: 1, stdout: "", stderr: "failed" });

    const result = await runForExtension(
      { name: "demo", changedFiles: [".pi/extensions/demo/index.ts"] },
      "diff",
      exec,
      undefined,
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.testPath).toBe(testPath);
    expect(result.testOutput).toBe("failed");
    expect(existsSync(testPath)).toBe(true);
  });

  it("returns typed subprocess phase failures and keeps generated diagnostics", async () => {
    const { root, testPath } = makeExtensionRoot();
    const exec: JitRunner = (cmd) => {
      if (cmd === "pi") return Effect.succeed({ code: 0, stdout: "import { describe } from 'vitest';", stderr: "" });
      return Effect.fail(new ProcessFailure({ kind: ProcessFailureKind.Spawn, command: "npm test", message: "spawn ENOENT" }));
    };

    const result = await runForExtension(
      { name: "demo", changedFiles: [".pi/extensions/demo/index.ts"] },
      "diff",
      exec,
      undefined,
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.testPath).toBe(testPath);
    expect(result.testOutput).toContain("Operational subprocess failure during run catching tests");
    expect(result.testOutput).toContain("spawn ENOENT");
    expect(existsSync(testPath)).toBe(true);
  });
});
