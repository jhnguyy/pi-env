#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function linuxCandidates() {
  if (process.platform !== "linux" || process.arch !== "x64") return [];
  // Some containerized/Nix-like environments report glibc to Node but can only
  // execute the musl jscpd binary. Try both pinned Linux x64 packages.
  return ["cpd-linux-x64-musl", "cpd-linux-x64-gnu"];
}

function platformCandidates() {
  const direct = {
    "darwin:arm64": "cpd-darwin-arm64",
    "darwin:x64": "cpd-darwin-x64",
    "win32:x64": "cpd-windows-x64-msvc",
  }[`${process.platform}:${process.arch}`];
  return [...linuxCandidates(), ...(direct ? [direct] : [])];
}

function binaryForPackage(packageName) {
  const binaryName = process.platform === "win32" ? "cpd.exe" : "cpd";
  return join(process.cwd(), "node_modules", packageName, "cpd-bin", binaryName);
}

const candidates = platformCandidates().map(binaryForPackage).filter(existsSync);
if (candidates.length === 0) {
  console.error(`jscpd v5 platform binary not installed for ${process.platform}/${process.arch}`);
  process.exit(1);
}

let lastError;
for (const binary of candidates) {
  const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
  if (!result.error) {
    if (result.signal) process.kill(process.pid, result.signal);
    process.exit(result.status ?? 0);
  }
  lastError = result.error;
  if (result.error.code !== "ENOENT") throw result.error;
}

console.error(`jscpd v5 binary failed to start: ${lastError?.message ?? "unknown error"}`);
process.exit(1);
