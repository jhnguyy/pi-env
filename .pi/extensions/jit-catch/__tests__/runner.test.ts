import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSourceFiles, resolveExtensionDir, resolveGitRoot } from "../runner";
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
