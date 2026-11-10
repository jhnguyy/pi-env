import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as TempDir from "../../src/testing/temp-dir.ts";

it("qualifies commands in the explicitly selected image root", () => {
  const directory = TempDir.forTestSync("pi-image-root-");
  const root = join(directory, "image");
  const bin = join(directory, "bin");
  const log = join(directory, "cwd.log");
  for (const path of ["THIRD_PARTY_LICENSES/system", "extensions/dev-tools/dist", "scripts"])
    mkdirSync(join(root, path), { recursive: true });
  mkdirSync(bin);
  for (const path of [
    "manifest.json",
    "THIRD_PARTY_NOTICES.md",
    "SOURCE_CODE.md",
    "system/node-LICENSE.txt",
  ])
    writeFileSync(join(root, "THIRD_PARTY_LICENSES", path), "fixture");
  for (const command of ["node", "nub"])
    writeFileSync(join(bin, command), '#!/bin/sh\nprintf "%s\\n" "$PWD" >> "$CWD_LOG"\n', {
      mode: 0o755,
    });
  writeFileSync(
    join(root, "scripts/generate-license-bundle.mjs"),
    'import { appendFileSync } from "node:fs"; appendFileSync(process.env.CWD_LOG, process.cwd() + "\\n");',
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../verify-image-artifact.mjs", import.meta.url)), "--root", root],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, CWD_LOG: log },
    },
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([root, root, root, root]);
});
