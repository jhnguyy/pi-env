#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();

function gitFiles() {
  const result = spawnSync("git", ["ls-files", ".pi/extensions", "scripts", "setup"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split("\n").filter((file) => /\.(ts|js|mjs)$/.test(file));
}

const findings = [];
for (const file of gitFiles()) {
  if (file === ".pi/extensions/_shared/errors.ts") continue;
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  if (/function\s+formatError\s*\(/.test(text)) {
    findings.push({
      file,
      message: "Local formatError helper found. Prefer .pi/extensions/_shared/errors.ts unless this is intentionally domain-specific.",
    });
  }
}

if (findings.length === 0) {
  console.log("No pattern-fragmentation findings.");
  process.exit(0);
}

console.log(`Pattern-fragmentation findings (${findings.length})`);
for (const finding of findings) {
  console.log(`${relative(ROOT, finding.file)}: ${finding.message}`);
}
process.exit(0);
