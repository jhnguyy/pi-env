#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { validatePiRuntimeInstall } from "./package-contract.mjs";

const [packageDir, manifestPath] = process.argv.slice(2);
if (!packageDir || !manifestPath || process.argv.length !== 4) {
  throw new Error("Usage: verify-pi-runtime.mjs <Pi package directory> <workbench package.json>");
}
const errors = validatePiRuntimeInstall(packageDir, JSON.parse(readFileSync(manifestPath, "utf8")));
if (errors.length > 0) throw new Error(errors.join("\n"));
