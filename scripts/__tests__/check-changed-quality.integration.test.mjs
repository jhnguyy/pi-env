import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

const repo = process.cwd();
const script = join(repo, "scripts", "check-changed-quality.mjs");
const complexSource = `export function complex(value: number) {
${Array.from({ length: 14 }, (_, index) => `if (value === ${index}) return ${index};`).join("\n")}
return -1;
}\n`;

async function sourceFixture() {
  const cwd = await fixtureRoot("quality-source-");
  for (const directory of ["scripts", "setup", "node_modules", ".pi"]) {
    await symlink(join(repo, directory), join(cwd, directory), "dir");
  }
  const project = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({
    type: "module",
    engines: project.engines,
    scripts: { "lint:sensors": project.scripts["lint:sensors"], analyze: project.scripts.analyze },
  }));
  await copyFile(join(repo, ".oxlintrc-sensors.json"), join(cwd, ".oxlintrc-sensors.json"));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/changed.ts"), "export const value = 0;\n");
  await writeFile(join(cwd, "src/existing.ts"), complexSource);
  execFileSync("git", ["init", "-b", "main"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd });
  return cwd;
}

function sensors(cwd, ...args) {
  return spawnSync("nub", ["run", "lint:sensors", "--format", "json", ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
}

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

describe("Oxlint sensor workflow", () => {
  it("reports built-in complexity and await warnings without failing advisory runs", async () => {
    const cwd = await sourceFixture();
    await writeFile(join(cwd, "src/changed.ts"), `${complexSource}
export async function work(values: number[]) {
  for (const value of values) {
    await Promise.resolve(value);
  }
}
`);
    const advisory = sensors(cwd, "src/changed.ts");
    expect(advisory.status, advisory.stderr).toBe(0);
    expect(JSON.parse(advisory.stdout).diagnostics.map(({ code }) => code).sort()).toEqual([
      "eslint(complexity)",
      "eslint(no-await-in-loop)",
    ]);
    expect(sensors(cwd, "--deny-warnings", "src/changed.ts").status).toBe(1);
  });

  it("respects the complexity boundary, test exclusions, and native await suppressions", async () => {
    const cwd = await sourceFixture();
    await writeFile(join(cwd, "src/changed.ts"), `${complexSource.replace("if (value === 13) return 13;", "")}
export async function work(values: number[]) {
  for (const value of values) {
    // oxlint-disable-next-line no-await-in-loop -- This fixture requires ordered work.
    await Promise.resolve(value);
  }
}
`);
    await writeFile(join(cwd, "src/ignored.test.ts"), complexSource);
    const result = sensors(cwd, "src/changed.ts", "src/ignored.test.ts");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).diagnostics).toEqual([]);
  });
});

describe("changed-code quality wrapper", () => {
  it.each([
    ["tracked complexity", "tracked", 1],
    ["untracked complexity", "untracked", 1],
    ["complexity outside the edited hunk", "hunk", 1],
    ["deleted complexity", "deleted", 0],
    ["unchanged complexity", "unchanged", 0],
    ["advisory awaits", "await", 0],
  ])("handles %s with the real Oxlint and Analyze CLIs", async (_name, scenario, status) => {
    const cwd = await sourceFixture();
    if (scenario === "tracked") await writeFile(join(cwd, "src/changed.ts"), complexSource);
    if (scenario === "untracked") await writeFile(join(cwd, "src/new file.ts"), complexSource);
    if (scenario === "hunk") await writeFile(join(cwd, "src/existing.ts"), `${complexSource}\nexport const extra = 1;\n`);
    if (scenario === "deleted") await rm(join(cwd, "src/existing.ts"));
    if (scenario === "await") await writeFile(join(cwd, "src/changed.ts"), `
export async function work(values: number[]) {
  for (const value of values) await Promise.resolve(value);
}
`);
    const result = run(cwd);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
    if (status === 1) expect(`${result.stdout}${result.stderr}`).toContain("complexity");
  }, 30_000);

  it("skips a packaged source tree without git metadata", async () => {
    const cwd = await fixtureRoot("quality-no-git-");
    const result = run(cwd);
    expect(result).toMatchObject({ status: 0 });
    expect(result.stdout).toContain("no git metadata");
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
