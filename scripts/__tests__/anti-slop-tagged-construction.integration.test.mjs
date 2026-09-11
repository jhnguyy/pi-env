import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const NODE_RUNNER_PATH = fileURLToPath(new URL("../tool-node-run.sh", import.meta.url));
const OXLINT_PATH = fileURLToPath(
  new URL("../../node_modules/oxlint/bin/oxlint", import.meta.url),
);
const PLUGIN_PATH = fileURLToPath(
  new URL("../../tools/oxlint/anti-slop/effect/index.ts", import.meta.url),
);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("anti-slop tagged construction rule", () => {
  it("rejects construction but accepts tagged assertion patterns", () => {
    const directory = mkdtempSync(join(ROOT, ".anti-slop-tagged-construction-"));
    temporaryDirectories.push(directory);
    const fixturePath = join(directory, "fixture.ts");
    const configPath = join(directory, "oxlint.json");

    writeFileSync(
      fixturePath,
      [
        'const assigned = { _tag: "assigned" };',
        'const fixture = makeFixture({ _tag: "fixture" });',
        'receiver.toMatchObject({ _tag: "not-expect" });',
        'expect(value).toMatchObject({ _tag: "expected", nested: { _tag: "nested" } });',
        'expect(value).toEqual({ _tag: "equal" });',
        'expect(value).not.toStrictEqual({ _tag: "strict" });',
        'expect(values).toContainEqual({ _tag: "contained-equal" });',
        'await expect(promise).rejects.toMatchObject({ _tag: "rejected" });',
        'expect.objectContaining({ _tag: "contained", nested: { _tag: "nested-contained" } });',
        'Match.when({ _tag: "matched", nested: { _tag: "nested-matched" } }, handler);',
      ].join("\n"),
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        jsPlugins: [{ name: "anti-slop-effect", specifier: PLUGIN_PATH }],
        categories: {
          correctness: "off",
          suspicious: "off",
          pedantic: "off",
          perf: "off",
          style: "off",
          restriction: "off",
          nursery: "off",
        },
        rules: { "anti-slop-effect/no-manual-tagged-construction": "error" },
      }),
    );

    const result = spawnSync(
      NODE_RUNNER_PATH,
      [OXLINT_PATH, fixturePath, "--config", configPath, "--format", "json"],
      { cwd: ROOT, encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(
      report.diagnostics.map((diagnostic) => diagnostic.labels[0].span.line),
    ).toEqual([1, 2, 3]);
  });
});
