import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as TempDir from "../../src/testing/temp-dir.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("resolves dictionary aliases in the caller scope and respects lexical interface shadowing", () => {
  const directory = TempDir.forTestSync("pi-dictionary-rule-");
  const config = join(directory, "oxlint.json");
  const source = join(directory, "source.ts");
  writeFileSync(
    config,
    JSON.stringify({
      jsPlugins: [{ name: "anti-slop", specifier: join(root, "tools/oxlint/anti-slop/index.ts") }],
      categories: { correctness: "off" },
      rules: { "anti-slop/no-unsafe-dictionary-type": "error" },
    }),
  );
  writeFileSync(
    source,
    [
      "type Pair<T, U> = Record<string, U>;",
      "type Swap<T, U> = Pair<U, T>;",
      "declare const unsafe: Swap<unknown, string>;",
      "type Defaulted<T, U = T> = Record<string, U>;",
      "declare const defaulted: Defaulted<unknown>;",
      "interface T {}",
      "const C = class T { value!: Record<string, T> };",
      "function generic<T>(value: Record<string, T>) {}",
      "class Generic<T> { value!: Record<string, T>; }",
      "function nested() { interface T { name: string } const value: Record<string, T> = {}; }",
      "declare const empty: Record<string, T>;",
    ].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/oxlint/bin/oxlint"), "--config", config, "--format", "json", source],
    { cwd: root, encoding: "utf8", timeout: 15_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(1);
  const diagnostics = JSON.parse(result.stdout).diagnostics;
  expect(
    diagnostics.every((diagnostic) => diagnostic.labels.length > 0),
    result.stdout,
  ).toBe(true);
  expect(
    diagnostics.map((diagnostic) => diagnostic.labels[0].span.line).sort((a, b) => a - b),
  ).toEqual([3, 5, 11]);
});
