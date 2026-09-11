import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const fixtureRoots = [];

async function fixtureRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const script = join(process.cwd(), "scripts", "check-changed-quality.mjs");

function run(cwd, env = {}) {
  return spawnSync(process.env.PI_ENV_NODE_BIN ?? process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${cwd}:${process.env.PATH}`,
      GITHUB_BASE_REF: "",
      GITHUB_HEAD_REF: "",
      GITHUB_ACTIONS: "",
      ...env,
    },
  });
}

async function fakeNub(cwd) {
  const path = join(cwd, "nub");
  await writeFile(path, '#!/bin/sh\necho "$@" >> nub-calls\n', "utf8");
  await chmod(path, 0o755);
}

describe("changed-code quality wrapper", () => {
  it("skips a packaged source tree without git metadata", async () => {
    const cwd = await fixtureRoot("quality-no-git-");
    expect(run(cwd)).toMatchObject({ status: 0 });
    expect(run(cwd).stdout).toContain("no git metadata");
  });

  it("skips a packaged git snapshot without a base ref", async () => {
    const cwd = await fixtureRoot("quality-no-base-");
    execFileSync("git", ["init", "-b", "feature"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "file.ts"), "export const one = 1;\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "snapshot"], { cwd });

    const result = run(cwd);
    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("no base ref");
  });

  it("uses an available base ref", async () => {
    const cwd = await fixtureRoot("quality-git-");
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "file.ts"), "export const one = 1;\n");
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });
    execFileSync("git", ["switch", "-c", "feature"], { cwd });
    await writeFile(join(cwd, "file.ts"), "export const one = 2;\n");
    execFileSync("git", ["commit", "-am", "change"], { cwd });
    await fakeNub(cwd);

    expect(run(cwd)).toMatchObject({ status: 0 });
    const calls = await readFile(join(cwd, "nub-calls"), "utf8");
    expect(calls).toContain("--ref");
    expect(calls).toContain("complexity,duplicates");
    expect(calls).toContain("async-risk");
  });
});
