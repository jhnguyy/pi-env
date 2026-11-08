import { execFile } from "node:child_process";
import { cp, mkdir, realpath, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import * as TempDir from "../../../src/testing/temp-dir";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));

it("builds and executes the public durable export in a host without CLI or TUI packages", async () => {
  const directory = await TempDir.forTest("notes-package-");
  const checkout = join(directory, "build");
  const host = join(directory, "host");
  const sourceOnly = (path: string) => !["dist", "__tests__"].includes(basename(path));
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await cp(join(repo, "package.json"), join(checkout, "package.json"));
  await cp(join(repo, "pi-build.config.json"), join(checkout, "pi-build.config.json"));
  for (const script of ["build-extensions.mjs", "extension-manifest.mjs", "node-policy.mjs"]) {
    await cp(join(repo, "scripts", script), join(checkout, "scripts", script));
  }
  for (const path of ["extensions/notes", "extensions/_shared", "src"]) {
    await cp(join(repo, path), join(checkout, path), { recursive: true, filter: sourceOnly });
  }
  await symlink(join(repo, "node_modules"), join(checkout, "node_modules"), "dir");
  // A fresh build directory prevents an old sidecar from hiding missing build configuration.
  await run(process.execPath, ["scripts/build-extensions.mjs", "notes"], {
    cwd: checkout,
    timeout: 15_000,
  });

  const packagePath = join(host, "node_modules/@pi-env/notes");
  await mkdir(packagePath, { recursive: true });
  await cp(join(checkout, "extensions/notes/package.json"), join(packagePath, "package.json"));
  await cp(join(checkout, "extensions/notes/dist"), join(packagePath, "dist"), { recursive: true });
  for (const name of [
    "@earendil-works/pi-durable",
    "@earendil-works/pi-ai",
    "@earendil-works/chord",
    "effect",
    "typebox",
  ]) {
    const target = join(host, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(await realpath(join(repo, "node_modules", name)), target, "dir");
  }
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/durable-host.ts", import.meta.url))],
    outfile: join(host, "probe.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const { stdout } = await run(process.execPath, ["probe.mjs"], {
    cwd: host,
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: join(host, "home"),
      PI_CODING_AGENT_DIR: join(host, "agent"),
      NODE_PATH: "",
      NODE_OPTIONS: "",
    },
  });
  expect(stdout.trim()).toBe("durable public export: read passed");
});
