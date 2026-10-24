#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runChecked } from "../setup/runtime-support.mjs";

const repo = process.cwd();
const languageServiceRoot = join(repo, "node_modules", "@effect", "language-service");
const languageServicePackage = JSON.parse(
  readFileSync(join(languageServiceRoot, "package.json"), "utf8"),
);
const patchMarker = `"use effect-lsp-patch-version ${languageServicePackage.version}";`;
const typeScriptLib = join(repo, "node_modules", "typescript", "lib");
const patchTargets = [join(typeScriptLib, "typescript.js"), join(typeScriptLib, "_tsc.js")];

if (!patchTargets.every((target) => readFileSync(target, "utf8").includes(patchMarker))) {
  const cli = join(languageServiceRoot, "cli.js");
  const nodeBin = process.argv[2] || process.env.PI_ENV_NODE_BIN || process.execPath;
  runChecked(nodeBin, [cli, "patch"], { cwd: repo });
}
