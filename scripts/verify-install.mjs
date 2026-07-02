#!/usr/bin/env node
// verify-install.mjs — cheap setup readiness checks, not a full test suite.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listExtensionDirs, loadExtensionManifest, relativeFromRepo, repoRoot } from "./extension-manifest.mjs";

const { pkg, config, extensionsDir, extensions } = loadExtensionManifest();
const errors = [];
const activeNames = new Set(extensions.map((ext) => ext.name));
const activePaths = new Set(extensions.map((ext) => ext.packagePath));

for (const ext of extensions) {
  const entry = join(ext.absPath, "index.ts");
  const bundle = join(ext.absPath, "dist/index.js");
  if (!existsSync(entry)) {
    errors.push(`${ext.name}: missing source entry ${relativeFromRepo(entry)}`);
  }
  if (!existsSync(bundle)) {
    errors.push(`${ext.name}: missing built bundle ${relativeFromRepo(bundle)}`);
  }
  for (const sidecar of config.sidecars?.[ext.name] ?? []) {
    const sidecarOut = join(ext.absPath, sidecar.outfile);
    if (!existsSync(sidecarOut)) {
      errors.push(`${ext.name}: missing built sidecar ${relativeFromRepo(sidecarOut)}`);
    }
  }
}

for (const packagePath of pkg.pi?.extensions ?? []) {
  const normalized = packagePath.replace(/^\.\//, "").replace(/\/$/, "");
  const manifest = join(repoRoot, ...normalized.split("/"), "package.json");
  if (!existsSync(manifest)) {
    errors.push(`package extension is missing package.json: ${normalized}`);
  }
}

for (const workspace of pkg.workspaces ?? []) {
  const normalized = workspace.replace(/^\.\//, "").replace(/\/$/, "");
  if (normalized.startsWith(`${extensionsDir}/`) && !activePaths.has(normalized)) {
    errors.push(`workspace extension is not registered in package pi.extensions: ${normalized}`);
  }
}

for (const ext of extensions) {
  if (!(pkg.workspaces ?? []).map((path) => path.replace(/^\.\//, "").replace(/\/$/, "")).includes(ext.packagePath)) {
    errors.push(`${ext.name}: package extension is missing from workspaces`);
  }
}

for (const sidecarName of Object.keys(config.sidecars ?? {})) {
  if (!activeNames.has(sidecarName)) {
    errors.push(`sidecar config references inactive extension: ${sidecarName}`);
  }
}

for (const dir of listExtensionDirs(extensionsDir)) {
  if (dir.name.startsWith("_") || activeNames.has(dir.name)) continue;
  const entries = readdirSync(dir.absPath);
  if (entries.includes("dist") && !entries.includes("index.ts")) {
    errors.push(`stale ignored extension artifact directory: ${relativeFromRepo(dir.absPath)} (run \`nub run clean:extensions\`)`);
  }
}

if (errors.length > 0) {
  console.error("Install readiness check failed:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Run `nub run build` and retry `nub run verify:install`.");
  process.exit(1);
}
console.log(`Install readiness check passed for ${extensions.length} extensions.`);
