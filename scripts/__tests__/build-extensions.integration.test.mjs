import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as TempDir from "../../src/testing/temp-dir.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

it.each([false, true])(
  "rejects a missing registered source even when an old bundle exists=%s",
  (oldBundle) => {
    const directory = TempDir.forTestSync("pi-build-contract-");
    mkdirSync(join(directory, "scripts"));
    for (const script of ["build-extensions.mjs", "extension-manifest.mjs", "node-policy.mjs"]) {
      copyFileSync(join(root, "scripts", script), join(directory, "scripts", script));
    }
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        engines: { node: ">=24.19.0" },
        workspaces: ["extensions/example"],
        pi: { extensions: ["extensions/example"] },
      }),
    );
    writeFileSync(join(directory, "pi-build.config.json"), "{}");
    mkdirSync(join(directory, "extensions/example/dist"), { recursive: true });
    if (oldBundle)
      writeFileSync(join(directory, "extensions/example/dist/index.js"), "stale bundle");
    // The compiler is not involved when a required input is missing.
    mkdirSync(join(directory, "node_modules/esbuild"), { recursive: true });
    writeFileSync(
      join(directory, "node_modules/esbuild/package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    writeFileSync(
      join(directory, "node_modules/esbuild/index.js"),
      "export async function build() { throw new Error('unexpected compilation'); }",
    );
    const result = spawnSync(process.execPath, [join(directory, "scripts/build-extensions.mjs")], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Missing registered extension source");
  },
);
