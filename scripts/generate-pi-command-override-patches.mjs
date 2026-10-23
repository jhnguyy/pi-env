#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [sourceArg, packageArg] = process.argv.slice(2);
if (!sourceArg || !packageArg || process.argv.length !== 4) {
  throw new Error(
    "Usage: generate-pi-command-override-patches.mjs <built Pi source checkout> <pristine published package>",
  );
}
const source = resolve(sourceArg);
const published = resolve(packageArg);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = manifest.devDependencies["@earendil-works/pi-coding-agent"];
const revision = JSON.parse(readFileSync(join(root, "flake.lock"), "utf8")).nodes.pi.locked.rev;
const sourceFiles = [
  "packages/coding-agent/src/core/agent-session.ts",
  "packages/coding-agent/src/core/extensions/loader.ts",
  "packages/coding-agent/src/core/extensions/runner.ts",
  "packages/coding-agent/src/core/extensions/types.ts",
  "packages/coding-agent/src/modes/interactive/interactive-mode.ts",
  "packages/coding-agent/test/suite/builtin-command-overrides.test.ts",
];

function git(cwd, args, diff = false) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(diff && result.status === 1))
    throw new Error(result.stderr || `git exited ${result.status}`);
  return result.stdout;
}

for (const path of [
  join(source, "packages/coding-agent/package.json"),
  join(published, "package.json"),
]) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== version) {
    throw new Error(`Expected Pi ${version}: ${path}`);
  }
}
if (git(source, ["rev-parse", "HEAD"]).trim() !== revision)
  throw new Error("Pi source HEAD does not match flake.lock");
const changed = git(source, ["diff", "HEAD", "--name-only"]).trim().split("\n");
if (
  changed.some((path) => !sourceFiles.includes(path)) ||
  sourceFiles.some((path) => !changed.includes(path))
) {
  throw new Error(
    "Expected exactly the command-override source files and its intent-to-add suite test",
  );
}
const sourcePatch = git(source, ["diff", "HEAD", "--", ...sourceFiles]);
const staging = mkdtempSync(join(tmpdir(), "pi-command-hook-patches-"));
try {
  const original = join(staging, "source");
  const patched = join(staging, "patched");
  cpSync(published, original, { recursive: true });
  cpSync(published, patched, { recursive: true });
  const built = join(source, "packages/coding-agent/dist");
  for (const path of sourceFiles.filter((path) => path.includes("/src/"))) {
    const entry = path.split("/src/")[1].replace(/\.ts$/, "");
    const sourceMap = JSON.parse(readFileSync(join(built, `${entry}.js.map`), "utf8"));
    if (
      sourceMap.sourcesContent?.length !== 1 ||
      sourceMap.sourcesContent[0] !== readFileSync(join(source, path), "utf8")
    ) {
      throw new Error(`Build output is stale for ${path}; rebuild Pi before generating patches`);
    }
    for (const suffix of [".js", ".d.ts", ".js.map", ".d.ts.map"]) {
      cpSync(join(built, `${entry}${suffix}`), join(patched, "dist", `${entry}${suffix}`));
    }
  }

  function files(dir, current = dir) {
    return readdirSync(current, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(dir, join(current, entry.name))
        : [relative(dir, join(current, entry.name))],
    );
  }
  const oldBundle = join(original, "dist/bundle");
  const newBundle = join(built, "bundle");
  const oldFiles = files(oldBundle);
  const newFiles = files(newBundle);
  if (oldFiles.length !== newFiles.length)
    throw new Error("Official bundle graph changed; review package patch generation");
  const normalize = (text) => text.replace(/-[A-Z0-9]{8}(?=\.js)/g, "-HASH");
  const hash = (text) => createHash("sha256").update(normalize(text)).digest("hex");
  const oldByHash = new Map();
  for (const name of oldFiles) {
    const key = hash(readFileSync(join(oldBundle, name), "utf8"));
    if (oldByHash.has(key)) throw new Error("Ambiguous original bundle chunk");
    oldByHash.set(key, name);
  }
  const mapping = new Map();
  const changedChunks = [];
  for (const name of newFiles) {
    const match = oldByHash.get(hash(readFileSync(join(newBundle, name), "utf8")));
    if (match) mapping.set(name, match);
    else changedChunks.push(name);
  }
  const oldChanged = oldFiles.filter((name) => ![...mapping.values()].includes(name));
  if (changedChunks.length !== 1 || oldChanged.length !== 1)
    throw new Error("Expected one changed command runtime chunk");
  mapping.set(changedChunks[0], oldChanged[0]);
  for (const [name, target] of mapping) {
    let content = readFileSync(join(newBundle, name), "utf8");
    for (const [from, to] of mapping) {
      if (from !== to) content = content.replaceAll(basename(from), basename(to));
    }
    if (name === changedChunks[0]) {
      if (
        !content.includes("supportsBuiltinCommandOverrides") ||
        !content.includes("tryExecuteBuiltinCommandOverride")
      ) {
        throw new Error("Changed bundle is not the command-override runtime");
      }
      writeFileSync(join(patched, "dist/bundle", target), content);
    } else if (content !== readFileSync(join(oldBundle, target), "utf8")) {
      throw new Error(`Unrelated official bundle output changed: ${name}`);
    }
  }
  // Retain published chunk names so unchanged entrypoints keep their original import graph.
  const packagePatch = git(
    staging,
    ["diff", "--no-index", "--no-ext-diff", "--", "source", "patched"],
    true,
  )
    .replace(/^diff --git a\/source\/(.+) b\/patched\/(.+)$/gm, "diff --git a/$1 b/$2")
    .replace(/^--- a\/source\//gm, "--- a/")
    .replace(/^\+\+\+ b\/patched\//gm, "+++ b/");
  if (!packagePatch) throw new Error("Generated package patch is empty");
  const output = join(root, "patches");
  mkdirSync(output, { recursive: true });
  const sourcePath = join(output, `pi-command-overrides-${version}.patch`);
  const packagePath = join(output, `pi-coding-agent-${version}.patch`);
  writeFileSync(sourcePath, sourcePatch);
  writeFileSync(packagePath, packagePatch);
  console.log(`${relative(root, sourcePath)}: ${Buffer.byteLength(sourcePatch)} bytes`);
  console.log(`${relative(root, packagePath)}: ${Buffer.byteLength(packagePatch)} bytes`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
