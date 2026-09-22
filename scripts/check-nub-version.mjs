#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function requiredNubVersion(packageJson) {
  const value = packageJson.packageManager;
  const match = typeof value === "string" ? /^nub@(\d+\.\d+\.\d+)$/.exec(value) : null;
  if (!match) throw new Error("package.json#packageManager must declare an exact Nub version");
  return match[1];
}

function installedNubVersion(output) {
  const value = output.trim();
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(value);
  if (!match) throw new Error(`Nub returned an invalid version: ${value || "<empty>"}`);
  return match[1];
}

function checkNubVersion(repo, nubBin = "nub") {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const required = requiredNubVersion(pkg);
  const result = spawnSync(nubBin, ["--version"], { cwd: repo, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Nub version check failed with status ${result.status}`);
  const installed = installedNubVersion(result.stdout);
  if (installed !== required) throw new Error(`Nub ${required} is required; found ${installed}`);
  return installed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const version = checkNubVersion(process.argv[2] || process.cwd(), process.env.NUB_BIN || "nub");
    console.log(`Nub ${version}`);
  } catch (error) {
    console.error(`pi-env: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
