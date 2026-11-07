import { spawnSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import * as TempDir from "../../testing/temp-dir";

it("reports duplicate functions through a deep expression with a constrained stack", async () => {
  const directory = await TempDir.forTest("analyze-stack-depth-");
  // Keep installed packages external without loading the Pi SDK or LSP.
  await symlink(
    fileURLToPath(new URL("../../../node_modules", import.meta.url)),
    join(directory, "node_modules"),
    "dir",
  );
  const entrypoint = join(directory, "fixture.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/stack-depth.ts", import.meta.url))],
    outfile: entrypoint,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });

  // This is fixed-input regression qualification, not an arbitrary-depth or
  // capacity guarantee. The recursive visitor overflows at this stack size.
  const result = spawnSync(process.execPath, ["--stack_size=128", entrypoint], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual([
    {
      id: "",
      analyzer: "duplicates",
      kind: "duplicate",
      severity: "warning",
      message: "Structurally duplicate function",
      location: { path: "sample.ts", line: 1, column: 1, endLine: 1, endColumn: 4136 },
      related: [{ path: "sample.ts", line: 2, column: 1, endLine: 2, endColumn: 4135 }],
    },
  ]);
});
