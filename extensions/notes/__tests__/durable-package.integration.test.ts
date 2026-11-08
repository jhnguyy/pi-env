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
  for (const path of [
    "package.json",
    "pi-build.config.json",
    "scripts",
    "extensions/notes",
    "extensions/_shared",
    "src",
  ]) {
    await cp(join(repo, path), join(checkout, path), { recursive: true, filter: sourceOnly });
  }
  await symlink(join(repo, "node_modules"), join(checkout, "node_modules"), "dir");
  // A fresh build directory prevents an old sidecar from hiding missing build configuration.
  const builder = join(checkout, "scripts/build-extensions.mjs");
  await run(process.execPath, [builder, "notes"], {
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
  const hostFixture = fileURLToPath(new URL("./fixtures/durable-host.ts", import.meta.url));
  const hostProgram = join(host, "probe.mjs");
  await build({
    entryPoints: [hostFixture],
    outfile: hostProgram,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const { stdout } = await run(process.execPath, [hostProgram], {
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
