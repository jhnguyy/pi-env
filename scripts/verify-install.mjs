#!/usr/bin/env node
// verify-install.mjs runs quick setup readiness checks. It is not a full test suite.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadExtensionManifest } from "./extension-manifest.mjs";
import { validateInstall } from "./install-contract.mjs";

function effectPatchIssues(repoRoot) {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (!packageJson.devDependencies?.["@effect/tsgo"]) return [];

  const modules = join(repoRoot, "node_modules");
  const native = JSON.parse(readFileSync(join(modules, "@typescript/native/package.json"), "utf8"));
  const effect = JSON.parse(readFileSync(join(modules, "@effect/tsgo/package.json"), "utf8"));
  const expected = `Version ${native.version}+effect-tsgo.${effect.version}`;
  const cli = join(modules, "@typescript/native/bin/tsc");
  const nodeBin = process.env.PI_ENV_NODE_BIN || process.env.NODE_EXECUTABLE || process.execPath;
  const result = spawnSync(nodeBin, [cli, "--version"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout.trim() === expected) return [];
  const detail =
    `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`.trim();
  return [`Effect TypeScript patch check failed${detail ? `: ${detail}` : ""}`];
}

const manifest = loadExtensionManifest();
const errors = [...validateInstall(manifest), ...effectPatchIssues(manifest.repoRoot)];

if (errors.length > 0) {
  console.error("Install readiness check failed.");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Run `nub run build`. Then retry `nub run verify:install`.");
  process.exit(1);
}
console.log(`Install readiness check passed for ${manifest.extensions.length} extensions.`);
