import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const repo = process.cwd();
const script = join(repo, "scripts", "check-changed-quality.mjs");
const repoCommand = (path) => `'${join(repo, path).replaceAll("'", "'\\''")}'`;
const complexSource = `export function complex(value: number) {
${Array.from({ length: 14 }, (_, index) => `if (value === ${index}) return ${index};`).join("\n")}
return -1;
}\n`;
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
  });

const it = test.extend({
  workspace: async ({}, use) => {
    const cwd = await mkdtemp(join(tmpdir(), "quality-"));
    try {
      await use(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  qualityWorkspace: async ({ workspace }, use) => {
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({
        type: "module",
        scripts: {
          "lint:sensors": `${repoCommand("scripts/tool-node-run.sh")} ${repoCommand("node_modules/oxlint/bin/oxlint")} -c .oxlintrc-sensors.json --threads=1`,
          analyze: `${repoCommand("scripts/node-run.sh")} ${repoCommand(".pi/extensions/analyze/dist/cli.js")}`,
        },
      }),
    );
    await copyFile(join(repo, ".oxlintrc-sensors.json"), join(workspace, ".oxlintrc-sensors.json"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src/changed.ts"), "export const value = 0;\n");
    await writeFile(join(workspace, "src/existing.ts"), complexSource);
    git(workspace, "init", "-b", "main");
    git(workspace, "add", ".");
    git(workspace, "commit", "-m", "baseline");
    await use(workspace);
  },
});

function run(cwd) {
  return spawnSync(process.env.PI_ENV_NODE_BIN ?? process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "", GITHUB_ACTIONS: "" },
  });
}

describe("changed-code quality workflow", { timeout: 30_000 }, () => {
  it("gates complexity in a changed file even outside the edited hunk", async ({
    qualityWorkspace,
  }) => {
    await writeFile(
      join(qualityWorkspace, "src/existing.ts"),
      `${complexSource}\nexport const extra = 1;\n`,
    );

    const result = run(qualityWorkspace);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("complexity");
  });

  it("gates untracked source paths with spaces", async ({ qualityWorkspace }) => {
    await writeFile(join(qualityWorkspace, "src/new file.ts"), complexSource);

    const result = run(qualityWorkspace);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("eslint(complexity)");
    expect(`${result.stdout}${result.stderr}`).toContain("new file.ts");
  });

  it("does not scan unchanged complex files for empty and ignored-only diffs", async ({
    qualityWorkspace,
  }) => {
    const empty = run(qualityWorkspace);
    expect(empty.status, `${empty.stdout}\n${empty.stderr}`).toBe(0);

    await writeFile(join(qualityWorkspace, "src/ignored.test.ts"), complexSource);
    const ignored = run(qualityWorkspace);
    expect(ignored.status, `${ignored.stdout}\n${ignored.stderr}`).toBe(0);
  });

  it("accepts changes selected only by sensor exclusions", async ({ qualityWorkspace }) => {
    await writeFile(join(qualityWorkspace, "src/readiness.test.ts"), "export const ready = true;\n");

    const result = run(qualityWorkspace);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("excludes deleted source files", async ({ qualityWorkspace }) => {
    await rm(join(qualityWorkspace, "src/existing.ts"));

    const result = run(qualityWorkspace);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("reports advisory awaits through the sensor script without blocking changed-code quality", async ({
    qualityWorkspace,
  }) => {
    const source = join(qualityWorkspace, "src/changed.ts");
    await writeFile(
      source,
      `
export async function work(values: number[]) {
  for (const value of values) await Promise.resolve(value);
}
`,
    );

    const advisory = spawnSync("nub", ["run", "lint:sensors", "--format", "json", source], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(advisory.status, advisory.stderr).toBe(0);
    expect(JSON.parse(advisory.stdout).diagnostics).toEqual([
      expect.objectContaining({ code: "eslint(no-await-in-loop)", severity: "warning" }),
    ]);

    const result = run(qualityWorkspace);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("skips a packaged source tree without git metadata", ({ workspace }) => {
    const result = run(workspace);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no git metadata");
  });

  it("skips a packaged git snapshot without a base ref", async ({ workspace }) => {
    git(workspace, "init", "-b", "feature");
    await writeFile(join(workspace, "file.ts"), "export const one = 1;\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-m", "snapshot");

    const result = run(workspace);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("no base ref");
  });
});
