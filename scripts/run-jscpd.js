#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const LINUX_X64_GNU = "cpd-linux-x64-gnu";
const LINUX_X64_MUSL = "cpd-linux-x64-musl";

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function detectLinuxLibc() {
  if (process.platform !== "linux") return undefined;
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function linuxCandidates() {
  if (process.platform !== "linux" || process.arch !== "x64") return [];
  const detected = detectLinuxLibc() === "glibc" ? LINUX_X64_GNU : LINUX_X64_MUSL;
  const fallback = detected === LINUX_X64_GNU ? LINUX_X64_MUSL : LINUX_X64_GNU;

  // Prefer the platform Node detects, but keep the alternate Linux x64 binary
  // as a fallback. Some containerized/Nix-like environments report glibc to
  // Node while the gnu binary is not executable in the runtime image.
  return [detected, fallback];
}

function platformCandidates() {
  const explicit = process.env.JSCPD_PLATFORM_PACKAGE;
  const direct = {
    "darwin:arm64": "cpd-darwin-arm64",
    "darwin:x64": "cpd-darwin-x64",
    "win32:x64": "cpd-windows-x64-msvc",
  }[`${process.platform}:${process.arch}`];
  return unique([explicit, ...linuxCandidates(), direct]);
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
