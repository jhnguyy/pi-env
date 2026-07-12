import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureDiff, readSourceFiles, resolveExtensionDir, resolveGitRoot, runForExtension } from "../runner";
import type { ExecFn } from "../runner";

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
    const exec: ExecFn = async () => ({ code: 0, stdout: "/repo/root\n", stderr: "" });

    await expect(resolveGitRoot(exec, "/repo/root/subdir")).resolves.toBe("/repo/root");
  });

  it("falls back to gitCwd when rev-parse fails", async () => {
    const exec: ExecFn = async () => ({ code: 128, stdout: "", stderr: "not a repo" });

    await expect(resolveGitRoot(exec, "/not/repo")).resolves.toBe("/not/repo");
  });
});

describe("captureDiff", () => {
  it("returns user-facing capture-diff failures unchanged", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "fatal: bad revision" });

    await expect(captureDiff("commit", exec, "/repo", "deadbeef")).rejects.toThrow(
      "git show failed (exit 1): fatal: bad revision",
    );
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

    const exec: ExecFn = async (cmd, _args, opts) => {
      if (cmd === "pi") return { code: 0, stdout: "import { describe } from 'vitest';", stderr: "" };

      const signal = opts?.signal;
      if (!signal) throw new Error("expected injected abort signal");

      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          signalAbortObservedResolve();
          reject(new Error("exec observed abort"));
        }, { once: true });
        setTimeout(() => controller.abort(), 0);
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
    const exec: ExecFn = async (cmd) => cmd === "pi"
      ? { code: 0, stdout: "import { describe } from 'vitest';", stderr: "" }
      : { code: 0, stdout: "pass", stderr: "" };

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
    const exec: ExecFn = async (cmd) => {
      if (cmd === "pi") return { code: 0, stdout: "import { describe } from 'vitest';", stderr: "" };
      rmSync(testPath, { force: true });
      return { code: 0, stdout: "pass", stderr: "" };
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

  it("keeps the generated catching test after a test failure", async () => {
    const { root, testPath } = makeExtensionRoot();
    const exec: ExecFn = async (cmd) => cmd === "pi"
      ? { code: 0, stdout: "import { describe } from 'vitest';", stderr: "" }
      : { code: 1, stdout: "", stderr: "failed" };

    const result = await runForExtension(
      { name: "demo", changedFiles: [".pi/extensions/demo/index.ts"] },
      "diff",
      exec,
      undefined,
      root,
    );

    expect(result.passed).toBe(false);
    expect(result.testPath).toBe(testPath);
    expect(existsSync(testPath)).toBe(true);
  });

  it("returns typed subprocess phase failures and keeps generated diagnostics", async () => {
    const { root, testPath } = makeExtensionRoot();
    const exec: ExecFn = async (cmd) => {
      if (cmd === "pi") return { code: 0, stdout: "import { describe } from 'vitest';", stderr: "" };
      throw new Error("spawn ENOENT");
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
