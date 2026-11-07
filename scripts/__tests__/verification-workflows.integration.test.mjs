import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { runProcess } from "../../src/process/platform.ts";
import { changedVerificationPlan } from "../verification-plan.mjs";

const repo = process.cwd();
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
    "--maxWorkers=1",
    "--no-file-parallelism",
    "src/defaults/__tests__",
  ]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(await readFile(marker, "utf8")).toBe("unit\n");
});

test("selects no work for an empty delta and only formatting for documentation", () => {
  expect(changedVerificationPlan({ base: "main", files: [], edited: [] })).toEqual([]);
  expect(
    changedVerificationPlan({ base: "main", files: ["README.md"], edited: ["README.md"] }),
  ).toEqual([
    {
      label: "format:files",
      command: "nub",
      args: ["run", "format:files", "--check", "--", "README.md"],
    },
  ]);
});

test("selects source checks and related units without whole-project type analysis", () => {
  expect(
    changedVerificationPlan({
      base: "main",
      files: ["src/feature/value.ts"],
      edited: ["src/feature/value.ts"],
    }),
  ).toEqual([
    {
      label: "format:files",
      command: "nub",
      args: ["run", "format:files", "--check", "--", "src/feature/value.ts"],
    },
    {
      label: "check:patterns",
      command: "nub",
      args: ["run", "check:patterns", "src/feature/value.ts"],
    },
    {
      label: "lint:changed",
      command: "nub",
      args: ["run", "lint:changed", "--", "src/feature/value.ts"],
    },
    {
      label: "check:duplicates:changed",
      command: "nub",
      args: ["run", "check:duplicates:changed", "--ref", "main"],
    },
    {
      label: "check:async-risk:changed",
      command: "nub",
      args: ["run", "check:async-risk:changed", "--ref", "main"],
    },
    {
      label: "test:unit",
      command: "nub",
      args: [
        "run",
        "test:unit",
        "related",
        "--maxWorkers=1",
        "--no-file-parallelism",
        "--bail=1",
        "--passWithNoTests",
        "./src/feature/value.ts",
      ],
    },
  ]);
});

it("lints the complete changed file without linting unchanged files", async ({ workspace }) => {
  // The complexity violation is already in the baseline; changing only the final
  // export proves the checker receives the whole file, not just added lines.
  const file = "src/feature/value.ts";
  await writeFile(join(workspace.root, file), complexSource);
  format(join(workspace.root, file));
  git(workspace.root, "add", file);
  git(workspace.root, "commit", "-m", "existing complexity violation");
  git(workspace.root, "branch", "-f", "main", "HEAD");
  await writeFile(
    join(workspace.root, file),
    `${await readFile(join(workspace.root, file), "utf8")}\nexport const extra = 1;\n`,
  );
  format(join(workspace.root, file));
  const result = await workspace.verify(["--checks-only"]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toContain("complexity");
  expect(`${result.stdout}${result.stderr}`).not.toContain("src/unrelated/complex.ts");
});

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

it("runs the owning component and transitive consumers without running unrelated tests", async ({
  workspace,
}) => {
  await writeFile(join(workspace.root, "src/feature/value.ts"), "export const value = 2;\n");
  const result = await workspace.verify();
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(
    (await readFile(join(workspace.root, "observed"), "utf8")).trim().split("\n").sort(),
  ).toEqual(["consumer", "feature"]);
  expect(`${result.stdout}${result.stderr}`).not.toContain("unrelated executed");
}, 45_000);

it("runs integration only when explicitly selected", async ({ workspace }) => {
  await writeFile(join(workspace.root, "src/feature/value.ts"), "export const value = 2;\n");
  const result = await workspace.run("test:integration", [
    "--maxWorkers=1",
    "--no-file-parallelism",
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

for (const exitCode of [7, 0]) {
  it(
    exitCode
      ? "propagates the supervised integration command's failure"
      : "runs full verification without Git metadata",
    async ({ workspace }) => {
      const marker = join(workspace.root, "integration-ran");
      const file = join(workspace.root, "package.json");
      const pkg = JSON.parse(await readFile(file, "utf8"));
      // Substitute only the expensive pipeline; keep the CLI, supervisor, lock,
      // and Nub script dispatch real. This does not qualify the pipeline's tools.
      const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(${exitCode});`;
      pkg.scripts["verify:integration"] = `node -e '${program.replaceAll("'", "'\\''")}'`;
      await writeFile(file, JSON.stringify(pkg));
      if (exitCode === 0) {
        await rm(join(workspace.root, ".git"), { recursive: true, force: true });
        const scoped = await workspace.verify(["--list"]);
        expect(scoped.exitCode).not.toBe(0);
      }
      const result = await workspace.run("verify:full");
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(exitCode);
      expect(await readFile(marker, "utf8")).toBe("ran");
    },
  );
}

it("fails clearly on an unknown base instead of fetching or widening the analysis", async ({
  workspace,
}) => {
  const result = await workspace.verify(["--base", "missing-base", "--list"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("missing-base");
});
