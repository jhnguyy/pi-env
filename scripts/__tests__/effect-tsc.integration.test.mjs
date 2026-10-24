import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";

const repo = process.cwd();

test("the compiler entrypoint reports TypeScript and Effect errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "effect typecheck "));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await symlink(join(repo, "node_modules"), join(directory, "node_modules"), "junction");
  const config = join(directory, "tsconfig.json");
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "preserve",
        moduleResolution: "bundler",
        strict: true,
        types: [],
        plugins: [{ name: "@effect/language-service" }],
      },
      files: ["source.ts"],
    }),
  );
  const source = join(directory, "source.ts");
  const run = () =>
    spawnSync("bash", [join(repo, "scripts/effect-tsc.sh"), "--noEmit", "--project", config], {
      cwd: directory,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, PI_ENV_TEST_TIMEOUT_MS: "10000" },
    });

  await writeFile(
    source,
    'import { Effect } from "effect";\nexport const value = Effect.succeed(1);\n',
  );
  const valid = run();
  expect(valid.error).toBeUndefined();
  expect(valid.status, valid.stdout + valid.stderr).toBe(0);

  await writeFile(source, "export const value: string = 1;\n");
  const typeError = run();
  expect(typeError.error).toBeUndefined();
  expect(typeError.status).toBeGreaterThan(0);
  expect(typeError.stdout + typeError.stderr).toContain("TS2322");

  await writeFile(source, 'import { Effect } from "effect";\nEffect.succeed(1);\n');
  const effectError = run();
  expect(effectError.error).toBeUndefined();
  expect(effectError.status).toBeGreaterThan(0);
  expect(effectError.stdout + effectError.stderr).toContain("effect(floatingEffect)");
});
