import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { runProcess } from "../../src/process/platform.ts";
import { runPlan } from "../verification-runner.mjs";

const repo = process.cwd();
const node = process.env.PI_ENV_NODE_BIN ?? process.execPath;
const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
const env = {
  ...process.env,
  GITHUB_BASE_REF: "",
  GITHUB_ACTIONS: "",
  PI_ENV_HEAVYWEIGHT_LOCK_TOKEN: "",
};
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: "pipe",
  });
const complexSource = `export function complex(value: number) {\n${Array.from({ length: 14 }, (_, i) => `if (value === ${i}) return ${i};`).join("\n")}\nreturn -1;\n}\n`;
const format = (file) =>
  execFileSync(join(repo, "scripts/tool-node-run.sh"), [
    join(repo, "node_modules/oxfmt/bin/oxfmt"),
    "--threads=1",
    file,
  ]);

const it = test.extend({
  workspace: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "verification-"));
    try {
      await symlink(join(repo, "scripts"), join(root, "scripts"), "dir");
      await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
      await mkdir(join(root, ".pi/extensions/analyze"), { recursive: true });
      await symlink(
        join(repo, ".pi/extensions/analyze/dist"),
        join(root, ".pi/extensions/analyze/dist"),
        "dir",
      );
      await copyFile(join(repo, ".oxlintrc-sensors.json"), join(root, ".oxlintrc-sensors.json"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ type: "module", engines: manifest.engines, scripts: manifest.scripts }),
      );
      await writeFile(join(root, ".gitignore"), "node_modules\n");
      await writeFile(
        join(root, "vitest.config.mjs"),
        `export default { test: {
  project: ['unit', 'integration', 'e2e'], globals: true, pool: 'forks', maxWorkers: 1, fileParallelism: false, forceRerunTriggers: [],
  projects: [
    { extends: true, test: { name: 'unit', include: ['src/**/*.test.mjs'], exclude: ['**/*.integration.test.mjs', '**/e2e.test.mjs'] } },
    { extends: true, test: { name: 'integration', include: ['src/**/*.integration.test.mjs'] } },
    { extends: true, test: { name: 'e2e', include: ['src/**/e2e.test.mjs'] } },
  ],
} };\n`,
      );
      for (const area of ["feature", "consumer", "unrelated"])
        await mkdir(join(root, `src/${area}/__tests__`), { recursive: true });
      await writeFile(join(root, "src/feature/value.ts"), "export const value = 1;\n");
      await writeFile(join(root, "src/unrelated/complex.ts"), complexSource);
      for (const [area, source] of [
        ["feature", "../value.ts"],
        ["consumer", "../../feature/value.ts"],
      ]) {
        await writeFile(
          join(root, `src/${area}/__tests__/value.test.mjs`),
          `import { appendFileSync } from 'node:fs';\nimport { value } from ${JSON.stringify(source)};\ntest(${JSON.stringify(area)}, () => { if (value !== 2) throw new Error('wrong value'); appendFileSync(${JSON.stringify(join(root, "observed"))}, ${JSON.stringify(`${area}\n`)}); });\n`,
        );
      }
      for (const [file, label] of [
        ["value.integration.test.mjs", "integration"],
        ["e2e.test.mjs", "e2e"],
      ]) {
        await writeFile(
          join(root, "src/consumer/__tests__", file),
          `import { appendFileSync } from 'node:fs';\nimport { value } from '../../feature/value.ts';\ntest(${JSON.stringify(label)}, () => { if (value !== 2) throw new Error('wrong value'); appendFileSync(${JSON.stringify(join(root, "observed"))}, ${JSON.stringify(`${label}\n`)}); });\n`,
        );
      }
      await writeFile(
        join(root, "src/unrelated/__tests__/never.test.mjs"),
        "test('unrelated must not run', () => { throw new Error('unrelated executed'); });\n",
      );
      git(root, "init", "-b", "main");
      git(root, "add", ".");
      git(root, "commit", "-m", "baseline");
      git(root, "checkout", "-b", "feature");
      const run = (script, args = []) =>
        Effect.runPromise(
          runProcess("nub", ["--no-env-file", "run", script, ...args], {
            cwd: root,
            env,
            timeoutMs: 40_000,
          }),
        );
      await use({ root, run, verify: (args = []) => run("verify", args) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

function phase(id, marker, exitCode) {
  return {
    label: id,
    command: node,
    args: [
      "-e",
      'require("node:fs").appendFileSync(process.argv[1], process.argv[2]); process.exit(Number(process.argv[3]));',
      marker,
      `${id}\n`,
      String(exitCode),
    ],
  };
}

it("stops sequential verification at failure and preserves its exit status", async ({
  workspace,
}) => {
  const marker = join(workspace.root, "completed-phases");
  expect(runPlan([phase("first", marker, 7), phase("second", marker, 0)])).toBe(7);
  expect(await readFile(marker, "utf8")).toBe("first\n");
});

it("stops when a phase cannot start", async ({ workspace }) => {
  const marker = join(workspace.root, "completed-phases");
  expect(
    runPlan([
      { label: "missing", command: join(workspace.root, "missing"), args: [] },
      phase("later", marker, 0),
    ]),
  ).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

it("uses the shipped isolated test configuration to stop after a failed case", async ({
  workspace,
}) => {
  const directory = join(workspace.root, "src/stop/__tests__");
  const marker = join(workspace.root, "completed-cases");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "workload.integration.test.ts"),
    `
import { appendFileSync } from 'node:fs';
import { it } from 'vitest';
it('fails', () => { appendFileSync(${JSON.stringify(marker)}, 'failed\\n'); throw new Error('expected failure'); });
it('must not run', () => { appendFileSync(${JSON.stringify(marker)}, 'later\\n'); });
`,
  );
  const result = await Effect.runPromise(
    runProcess(
      "nub",
      [
        "--no-env-file",
        "run",
        "test",
        "--config",
        join(repo, "vitest.config.ts"),
        "--root",
        workspace.root,
        "--project",
        "integration",
        "src/stop/__tests__/workload.integration.test.ts",
      ],
      { cwd: workspace.root, env, timeoutMs: 20_000 },
    ),
  );
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(await readFile(marker, "utf8")).toBe("failed\n");
});

it("defaults to units with the shipped test configuration", async ({ workspace }) => {
  const directory = join(workspace.root, "src/defaults/__tests__");
  const marker = join(workspace.root, "selected-projects");
  await mkdir(directory, { recursive: true });
  for (const [file, label] of [
    ["value.test.ts", "unit"],
    ["value.integration.test.ts", "integration"],
    ["e2e.test.ts", "e2e"],
  ]) {
    await writeFile(
      join(directory, file),
      `import { appendFileSync } from 'node:fs';\nimport { it } from 'vitest';\nit(${JSON.stringify(label)}, () => appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${label}\n`)}));\n`,
    );
  }
  const result = await workspace.run("test", [
    "--config",
    join(repo, "vitest.config.ts"),
    "--root",
    workspace.root,
    "src/defaults/__tests__",
  ]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(await readFile(marker, "utf8")).toBe("unit\n");
});

it("does no analysis for an empty or documentation-only delta", async ({ workspace }) => {
  for (const content of [undefined, "# Documentation\n"]) {
    if (content) await writeFile(join(workspace.root, "README.md"), content);
    const result = await workspace.verify(["--checks-only"]);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).not.toContain("type-aware lint");
    expect(result.stdout).not.toContain("typecheck");
  }
});

for (const state of ["committed", "staged", "unstaged", "untracked with spaces"]) {
  it(`checks complete ${state} files without linting unchanged files`, async ({ workspace }) => {
    const file =
      state === "untracked with spaces" ? "src/feature/new file.ts" : "src/feature/value.ts";
    await writeFile(join(workspace.root, file), `${complexSource}\nexport const extra = 1;\n`);
    format(join(workspace.root, file));
    if (state === "staged" || state === "committed") git(workspace.root, "add", file);
    if (state === "committed") git(workspace.root, "commit", "-m", "change");
    const result = await workspace.verify(["--checks-only"]);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain("complexity");
    expect(`${result.stdout}${result.stderr}`).not.toContain("src/unrelated/complex.ts");
  });
}

it("checks source policy only on the delta, while explicit full policy also works without Git", async ({
  workspace,
}) => {
  await writeFile(
    join(workspace.root, "src/unrelated/policy.ts"),
    "const invalid = flow(operation);\n",
  );
  git(workspace.root, "add", "src/unrelated/policy.ts");
  git(workspace.root, "commit", "-m", "existing policy violation");
  git(workspace.root, "branch", "-f", "main", "HEAD");
  await writeFile(join(workspace.root, "src/feature/value.ts"), "export const value = 2;\n");
  const clean = await workspace.verify(["--checks-only"]);
  expect(clean.exitCode, `${clean.stdout}\n${clean.stderr}`).toBe(0);
  await writeFile(
    join(workspace.root, "src/feature/value.ts"),
    "const invalid = flow(operation);\n",
  );
  const rejected = await workspace.verify(["--checks-only"]);
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stdout).toContain("flow(...) composition is not allowed");
  await rm(join(workspace.root, ".git"), { recursive: true, force: true });
  const full = await workspace.run("check:patterns");
  expect(full.exitCode).toBe(1);
  expect(full.stdout).toContain("src/unrelated/policy.ts");
});

it("preserves sensor exclusions and nonblocking advisory awaits", async ({ workspace }) => {
  await writeFile(join(workspace.root, "src/feature/ignored.test.ts"), complexSource);
  const source = join(workspace.root, "src/feature/value.ts");
  await writeFile(
    source,
    "export async function work(values: number[]) { for (const value of values) await Promise.resolve(value); }\n",
  );
  format(source);
  format(join(workspace.root, "src/feature/ignored.test.ts"));
  const advisory = execFileSync(
    join(repo, "scripts/tool-node-run.sh"),
    [
      join(repo, "node_modules/oxlint/bin/oxlint"),
      "-c",
      join(repo, ".oxlintrc-sensors.json"),
      "--threads=1",
      "--format",
      "json",
      source,
    ],
    { encoding: "utf8" },
  );
  expect(JSON.parse(advisory).diagnostics).toEqual([
    expect.objectContaining({ code: "eslint(no-await-in-loop)", severity: "warning" }),
  ]);
  const result = await workspace.verify(["--checks-only"]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
});

it("keeps both sides of a rename for impact selection but never passes deleted paths to source checkers", async ({
  workspace,
}) => {
  git(workspace.root, "mv", "src/feature/value.ts", "src/consumer/new name.ts");
  const result = await workspace.verify(["--list"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const lines = result.stdout.split("\n");
  expect(
    lines.some(
      (line) =>
        line.includes("test:unit related") &&
        line.includes("src/feature/value.ts") &&
        line.includes("src/consumer/new name.ts"),
    ),
  ).toBe(true);
  expect(
    lines.some(
      (line) => /format|lint:|patterns/.test(line) && line.includes("src/feature/value.ts"),
    ),
  ).toBe(false);
});

it("checks every changed shell script rather than treating later paths as arguments", async ({
  workspace,
}) => {
  await writeFile(join(workspace.root, "first.sh"), "#!/bin/bash\ntrue\n");
  await writeFile(join(workspace.root, "second.sh"), "#!/bin/bash\nif\n");
  const result = await workspace.verify(["--checks-only"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("second.sh");
});

it("runs the owning component and transitive consumers without running unrelated tests or type analysis", async ({
  workspace,
}) => {
  await writeFile(join(workspace.root, "src/feature/value.ts"), "export const value = 2;\n");
  const result = await workspace.verify();
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(
    (await readFile(join(workspace.root, "observed"), "utf8")).trim().split("\n").sort(),
  ).toEqual(["consumer", "feature"]);
  expect(`${result.stdout}${result.stderr}`).not.toContain("unrelated executed");
  expect(result.stdout).not.toContain("typecheck");
  expect(result.stdout).not.toContain("type-aware lint");
}, 45_000);

it("runs integration only when explicitly selected", async ({ workspace }) => {
  await writeFile(join(workspace.root, "src/feature/value.ts"), "export const value = 2;\n");
  const result = await workspace.run("test:integration", [
    "src/consumer/__tests__/value.integration.test.mjs",
  ]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(await readFile(join(workspace.root, "observed"), "utf8")).toBe("integration\n");
});

it("executes a changed test itself without selecting unrelated components", async ({
  workspace,
}) => {
  const file = join(workspace.root, "src/consumer/__tests__/value.test.mjs");
  await writeFile(
    file,
    `import { appendFileSync } from 'node:fs';\ntest('changed test', () => appendFileSync(${JSON.stringify(join(workspace.root, "observed"))}, 'changed'));\n`,
  );
  format(file);
  const result = await workspace.verify();
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(await readFile(join(workspace.root, "observed"), "utf8")).toBe("changed");
});

it("selects component suites for non-imported filesystem inputs", async ({ workspace }) => {
  git(workspace.root, "checkout", "main");
  await writeFile(join(workspace.root, "src/feature/value.ts"), "export const value = 2;\n");
  git(workspace.root, "commit", "-am", "update baseline");
  git(workspace.root, "checkout", "feature");
  git(workspace.root, "merge", "--ff-only", "main");
  await writeFile(join(workspace.root, "src/feature/input.json"), "{}\n");
  const result = await workspace.verify();
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(await readFile(join(workspace.root, "observed"), "utf8")).toBe("feature\n");
});

it("rejects unsupported full-run options before starting work", async ({ workspace }) => {
  const result = await workspace.run("verify:full", ["--list"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--list");
});

for (const failure of [undefined, "typecheck"]) {
  it(`runs the package-owned full sequence ${failure ? "until a failed tool" : "without Git metadata"}`, async ({
    workspace,
  }) => {
    const tools = [
      "format:check",
      "check:patterns",
      "check:dependencies",
      "licenses:check",
      "typecheck",
      "lint:type",
      "build",
      "test:setup",
      "test:unit",
      "test:integration",
      "verify:install",
      "test:workflows",
    ];
    const marker = join(workspace.root, "completed-tools");
    const file = join(workspace.root, "package.json");
    const pkg = JSON.parse(await readFile(file, "utf8"));
    // The real Nub pipeline runs small executable tools here; their analysis and
    // build behavior is outside this sequencing/exit-propagation scenario.
    for (const tool of tools) {
      const program = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${tool}\\n`)}); process.exit(${tool === failure ? 7 : 0});`;
      pkg.scripts[tool] = `node -e '${program.replaceAll("'", "'\\''")}'`;
    }
    await writeFile(file, JSON.stringify(pkg));
    await rm(join(workspace.root, ".git"), { recursive: true, force: true });
    const scoped = await workspace.verify(["--list"]);
    expect(scoped.exitCode).not.toBe(0);
    const result = await workspace.run("verify:full");
    expect(result.exitCode, `${result.stdout}\\n${result.stderr}`).toBe(failure ? 7 : 0);
    const expected = failure ? tools.slice(0, tools.indexOf(failure) + 1) : tools;
    expect(await readFile(marker, "utf8")).toBe(expected.map((tool) => `${tool}\\n`).join(""));
  }, 45_000);
}

it("fails clearly on an unknown base instead of fetching or widening the analysis", async ({
  workspace,
}) => {
  const result = await workspace.verify(["--base", "missing-base", "--list"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("missing-base");
});
