import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { runProcess } from "../../src/process/platform.ts";
import { runPlan } from "../verification-runner.mjs";

const node = process.env.PI_ENV_NODE_BIN ?? process.execPath;
const quiet = { log: () => {}, logError: () => {} };
const it = test.extend({
  workspace: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), "verification-runner-"));
    try {
      await use({ root, marker: join(root, "completed-phases") });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
});

function phase(id, marker, exitCode) {
  return {
    id,
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

it("verification stops at a failed phase and preserves its exit status", async ({ workspace }) => {
  expect(
    runPlan([phase("first", workspace.marker, 7), phase("second", workspace.marker, 0)], quiet),
  ).toBe(7);
  expect(await readFile(workspace.marker, "utf8")).toBe("first\n");
});

it("verification stops when a phase cannot start", async ({ workspace }) => {
  const missing = {
    id: "missing",
    label: "missing executable",
    command: join(workspace.root, "missing"),
    args: [],
  };
  expect(runPlan([missing, phase("second", workspace.marker, 0)], quiet)).toBe(1);
  expect(existsSync(workspace.marker)).toBe(false);
});

it("safe execution stops before later batches when a workload fails", async ({ workspace }) => {
  const repo = process.cwd();
  const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  const scripts = {};
  for (const name of ["test", "test:safe"]) {
    scripts[name] = manifest.scripts[name].replace(
      /\bscripts\/[^\s]+/g,
      (path) => `'${join(repo, path).replaceAll("'", "'\\''")}'`,
    );
  }
  await writeFile(
    join(workspace.root, "package.json"),
    JSON.stringify({
      type: "module",
      engines: manifest.engines,
      scripts,
    }),
  );
  await writeFile(
    join(workspace.root, "vitest.config.mjs"),
    `export default ${JSON.stringify({
      test: {
        globals: true,
        maxWorkers: 1,
        projects: [{ extends: true, test: { name: "workload", include: ["*.test.mjs"] } }],
      },
    })}`,
  );
  for (const [name, label, fail] of [
    ["01-pass", "first", false],
    ["02-fail", "failed", true],
    ["03-later", "later", false],
  ]) {
    await writeFile(
      join(workspace.root, `${name}.test.mjs`),
      [
        'import { appendFileSync } from "node:fs";',
        `test(${JSON.stringify(label)}, () => {`,
        `appendFileSync(${JSON.stringify(workspace.marker)}, ${JSON.stringify(`${label}\n`)});`,
        fail ? 'throw new Error("expected workload failure");' : "",
        "});",
      ].join("\n"),
    );
  }

  const result = await Effect.runPromise(
    runProcess("nub", ["--no-env-file", "run", "test:safe"], {
      cwd: workspace.root,
      env: { ...process.env, PI_ENV_SAFE_INTEGRATION_BATCH_SIZE: "1" },
      timeoutMs: 20_000,
    }),
  );
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(await readFile(workspace.marker, "utf8")).toBe("first\nfailed\n");
});
