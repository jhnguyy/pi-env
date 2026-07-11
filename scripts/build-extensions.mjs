#!/usr/bin/env node
// build-extensions.mjs — Compile each package-registered extension to single-file Node ESM bundles.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { loadExtensionManifest } from "./extension-manifest.mjs";
import { esbuildNodeTarget } from "./node-policy.mjs";

const { config, extensions } = loadExtensionManifest();
const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: esbuildNodeTarget(),
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

// analyze: allow-sequential
for (const ext of extensions) {
  const outdir = join(ext.absPath, "dist");
  if (!existsSync(ext.sourceEntry)) {
    console.log(`  skip  ${ext.name} (no index.ts)`);
    continue;
  }
  mkdirSync(outdir, { recursive: true });
  try {
    await buildFile(ext.sourceEntry, ext.bundleEntry);
    for (const sidecar of ext.sidecars) {
      await buildFile(
        sidecar.absEntry,
        sidecar.absOutfile,
        { banner: sidecar.banner === false ? undefined : common.banner },
      );
    }
    console.log(`  built ${ext.name}`);
    ok += 1;
  } catch (err) {
    console.error(`  FAIL  ${ext.name}`);
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
