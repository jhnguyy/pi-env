import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createJitCatchExtension } from "../index";

const fixtures: string[] = [];
const originalPath = process.env.PATH;

function makeFixture(): {
  readonly root: string;
  readonly testPath: string;
  readonly observationPath: string;
  readonly generatorObservationPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "jit-catch-repository-runner-"));
  fixtures.push(root);

  const extensionDir = join(root, ".pi", "extensions", "demo");
  const binDir = join(root, "bin");
  mkdirSync(extensionDir, { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(extensionDir, "index.ts"), "export const demo = true;\n");

  const generatedTest =
    "import { expect, it } from 'vitest';\nit('observes the named behavior', () => expect(true).toBe(true));";
  const generatorObservationPath = join(root, "generator-invoked");
  const piPath = join(binDir, "pi");
  writeFileSync(
    piPath,
    `#!/bin/sh\ntouch '${generatorObservationPath}'\nprintf '%s\\n' "${generatedTest}"\n`,
  );
  chmodSync(piPath, 0o755);

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "jit-catch-fixture",
        private: true,
        packageManager: "npm@10.0.0",
        scripts: { test: `${process.env.NODE_EXECUTABLE ?? "node"} verify-test.mjs` },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "jit-catch-fixture",
      lockfileVersion: 3,
      packages: { "": { name: "jit-catch-fixture" } },
    }),
  );
  writeFileSync(
    join(root, "verify-test.mjs"),
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "const expected = '.pi/extensions/demo/__tests__/demo.catching.test.ts';",
      "const actual = process.argv[2];",
      "const observation = { cwd: process.cwd(), expected, actual, testExists: existsSync(actual ?? '') };",
      "writeFileSync('test-observation.json', JSON.stringify(observation, null, 2));",
      "if (actual !== expected || !observation.testExists) process.exit(1);",
    ].join("\n"),
  );

  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
  return {
    root,
    testPath: join(extensionDir, "__tests__", "demo.catching.test.ts"),
    observationPath: join(root, "test-observation.json"),
    generatorObservationPath,
  };
}

function registeredTool() {
  const tools: any[] = [];
  createJitCatchExtension()({
    registerTool: (tool: any) => tools.push(tool),
    events: { emit: vi.fn() },
    on: vi.fn(),
  } as any);
  return tools[0];
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

it("runs the repository-owned test script from its workspace with the generated test filter", async () => {
  const fixture = makeFixture();
  const diff =
    "diff --git a/.pi/extensions/demo/index.ts b/.pi/extensions/demo/index.ts\n+++ b/.pi/extensions/demo/index.ts";

  const result = await registeredTool().execute(
    "acceptance",
    { diff, behavior: "the repository test script receives and executes the generated diagnostic" },
    undefined,
    undefined,
    { cwd: fixture.root },
  );

  expect(result.details, JSON.stringify(result)).toMatchObject({ anyFailed: false });
  expect(JSON.parse(readFileSync(fixture.observationPath, "utf8"))).toEqual({
    cwd: fixture.root,
    expected: ".pi/extensions/demo/__tests__/demo.catching.test.ts",
    actual: ".pi/extensions/demo/__tests__/demo.catching.test.ts",
    testExists: true,
  });
  expect(existsSync(fixture.generatorObservationPath)).toBe(true);
  expect(existsSync(fixture.testPath)).toBe(false);
}, 30_000);

it.each(["missing test script", "inherited manager name"])("rejects %s before generation or test-file creation", async (invalidConfiguration) => {
  const fixture = makeFixture();
  writeFileSync(
    join(fixture.root, "package.json"),
    JSON.stringify({
      name: "jit-catch-fixture",
      private: true,
      ...(invalidConfiguration === "missing test script"
        ? { packageManager: "npm@10.0.0" }
        : { packageManager: "constructor@1.0.0", scripts: { test: "node --version" } }),
    }),
  );
  const diff =
    "diff --git a/.pi/extensions/demo/index.ts b/.pi/extensions/demo/index.ts\n+++ b/.pi/extensions/demo/index.ts";

  const result = await registeredTool().execute(
    "missing-test-script",
    { diff, behavior: "the generated diagnostic is admitted only with an owned test script" },
    undefined,
    undefined,
    { cwd: fixture.root },
  );

  expect(result.details).toMatchObject({ anyFailed: true });
  expect(existsSync(fixture.generatorObservationPath)).toBe(false);
  expect(existsSync(fixture.testPath)).toBe(false);
});
