#!/usr/bin/env node
// build-extensions.mjs — Compile each extension to single-file Node ESM bundles.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(repoRoot, "pi-build.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const extDir = join(repoRoot, config.extensionsDir ?? ".pi/extensions");

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22.19",
  sourcemap: false,
  external: config.externals ?? [],
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

for (const ext of config.extensions ?? []) {
  const entry = join(extDir, ext, "index.ts");
  const outdir = join(extDir, ext, "dist");
  if (!existsSync(entry)) {
    console.log(`  skip  ${ext} (no index.ts)`);
    continue;
  }

  mkdirSync(outdir, { recursive: true });
  try {
    await buildFile(entry, join(outdir, "index.js"));

    for (const sidecar of config.sidecars?.[ext] ?? []) {
      await buildFile(
        join(extDir, ext, sidecar.entry),
        join(extDir, ext, sidecar.outfile),
        { banner: sidecar.banner === false ? undefined : common.banner },
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
