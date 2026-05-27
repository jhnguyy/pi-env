#!/usr/bin/env node
// build-extensions.mjs — Compile each extension to single-file Node ESM bundles.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const extDir = join(repoRoot, ".pi", "extensions");

const peerExternals = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core",
  "typebox",
  "@sinclair/typebox",
  "esbuild",
];

const extensions = [
  "dev-tools",
  "jit-catch",
  "ptc",
  "security",
  "skill-builder",
  "subagent",
  "work-tracker",
];

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22.19",
  sourcemap: false,
  external: peerExternals,
  logLevel: "silent",
  banner: {
    js: "import { createRequire as __piCreateRequire } from 'node:module'; import { fileURLToPath as __piFileURLToPath } from 'node:url'; import { dirname as __piDirname } from 'node:path'; const require = __piCreateRequire(import.meta.url); const __filename = __piFileURLToPath(import.meta.url); const __dirname = __piDirname(__filename);",
  },
};

let ok = 0;
let fail = 0;

async function buildFile(entry, outfile, options = {}) {
  await build({
    ...common,
    entryPoints: [entry],
    outfile,
    ...options,
  });
}

for (const ext of extensions) {
  const entry = join(extDir, ext, "index.ts");
  const outdir = join(extDir, ext, "dist");
  if (!existsSync(entry)) {
    console.log(`  skip  ${ext} (no index.ts)`);
    continue;
  }

  mkdirSync(outdir, { recursive: true });
  try {
    await buildFile(entry, join(outdir, "index.js"));

    if (ext === "ptc") {
      await buildFile(
        join(extDir, "ptc", "subprocess-preamble.ts"),
        join(outdir, "subprocess-preamble.js"),
        { banner: undefined },
      );
    }

    if (ext === "dev-tools") {
      await buildFile(
        join(extDir, "dev-tools", "daemon.ts"),
        join(outdir, "daemon.js"),
        { banner: undefined },
      );
    }

    console.log(`  built ${ext}`);
    ok += 1;
  } catch (err) {
    console.error(`  FAIL  ${ext}`);
    if (err?.errors) {
      for (const e of err.errors) console.error(e.text ?? String(e));
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    fail += 1;
  }
}

console.log("");
if (fail === 0) {
  console.log(`All ${ok} extensions built successfully.`);
} else {
  console.error(`${ok} built, ${fail} failed.`);
  process.exit(1);
}
