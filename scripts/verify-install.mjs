#!/usr/bin/env node
// verify-install.mjs — cheap setup readiness checks, not a full test suite.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(repoRoot, "pi-build.config.json");
const pkgPath = join(repoRoot, "package.json");

const config = JSON.parse(readFileSync(configPath, "utf8"));
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const extDir = join(repoRoot, config.extensionsDir ?? ".pi/extensions");
const errors = [];

for (const ext of config.extensions ?? []) {
  const entry = join(extDir, ext, "index.ts");
  const bundle = join(extDir, ext, "dist/index.js");
  if (!existsSync(entry)) {
    errors.push(`${ext}: missing source entry ${entry}`);
  }
  if (!existsSync(bundle)) {
    errors.push(`${ext}: missing built bundle ${bundle}`);
  }

  for (const sidecar of config.sidecars?.[ext] ?? []) {
    const sidecarOut = join(extDir, ext, sidecar.outfile);
    if (!existsSync(sidecarOut)) {
      errors.push(`${ext}: missing built sidecar ${sidecarOut}`);
    }
  }
}

for (const packagePath of pkg.pi?.extensions ?? []) {
  const manifest = join(repoRoot, packagePath, "package.json");
  if (!existsSync(manifest)) {
    errors.push(`package extension is missing package.json: ${packagePath}`);
  }
}

if (errors.length > 0) {
  console.error("Install readiness check failed:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Run `npm run build` and retry `npm run verify:install`.");
  process.exit(1);
}

console.log(`Install readiness check passed for ${(config.extensions ?? []).length} extensions.`);
