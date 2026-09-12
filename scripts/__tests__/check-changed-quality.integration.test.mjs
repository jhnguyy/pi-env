import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
