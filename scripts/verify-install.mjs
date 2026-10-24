#!/usr/bin/env node
// verify-install.mjs runs quick setup readiness checks. It is not a full test suite.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadExtensionManifest } from "./extension-manifest.mjs";
import { validateInstall } from "./install-contract.mjs";

function effectPatchIssues(repoRoot) {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (!packageJson.devDependencies?.["@effect/language-service"]) return [];

  const cli = join(repoRoot, "node_modules", "@effect", "language-service", "cli.js");
  const nodeBin = process.env.PI_ENV_NODE_BIN || process.env.NODE_EXECUTABLE || process.execPath;
  const result = spawnSync(nodeBin, [cli, "check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0) return [];
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
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
