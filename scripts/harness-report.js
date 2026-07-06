#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const CHECKS = [
  {
    name: "dependency boundaries",
    command: "nub",
    args: ["run", "check:deps"],
    blocking: true,
    hint: formatDependencyCruiser,
    files: [".dependency-cruiser.cjs", "package.json", "lock.yaml"],
  },
  {
    name: "clone detection",
    command: "nub",
    args: ["run", "check:clones"],
    blocking: false,
    hint: formatJscpd,
    files: [".jscpd.json", "scripts/run-jscpd.js", "package.json", "lock.yaml"],
  },
  {
    name: "unused code",
    command: "nub",
    args: ["run", "check:unused"],
    blocking: false,
    hint: formatKnip,
    files: ["knip.json", "package.json", "lock.yaml"],
  },
  {
    name: "pattern fragmentation",
    command: "nub",
    args: ["run", "check:patterns"],
    blocking: false,
    hint: formatPatterns,
    files: ["scripts/check-patterns.js"],
  },
];

function printFiles() {
  console.log("Harness file requirements:");
  for (const check of CHECKS) {
    console.log(`\n${check.name}:`);
    for (const file of check.files ?? []) console.log(`- ${file}`);
  }
}

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function run(check) {
  const result = spawnSync(check.command, check.args, { encoding: "utf8" });
  const output = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`.trim());
  return {
    ...check,
    status: result.status ?? (result.error ? 1 : 0),
    output: result.error ? result.error.message : output,
  };
}

function formatDependencyCruiser(output) {
  const lines = output.split("\n").filter((line) => line.trim().startsWith("error "));
  if (lines.length === 0) return [];
  return lines.map((line) => {
    const match = line.trim().match(/^error\s+([^:]+):\s+(.+?)\s+→\s+(.+)$/);
    if (!match) return `Dependency boundary violation: ${line.trim()}`;
    const [, rule, from, to] = match;
    return `Dependency boundary violation (${rule}): ${from} imports ${to}. Move shared code to .pi/extensions/_shared or keep the import inside the owning extension, then re-run check:deps.`;
  });
}

function formatJscpd(output) {
  const lines = output.split("\n");
  const instructions = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes("Clone found")) continue;
    const first = lines[i + 1]?.replace(/^\s*-\s*/, "").trim();
    const second = lines[i + 2]?.trim();
    if (first && second) {
      instructions.push(`Duplicate code: ${first} also appears at ${second}. Reuse or extract the shared behavior, then re-run check:clones.`);
    }
  }
  return instructions;
}

function formatPatterns(output) {
  if (output.includes("No pattern-fragmentation findings")) return [];
  return output.split("\n")
    .filter((line) => line.includes(":"))
    .map((line) => `Pattern fragmentation: ${line.trim()} Reuse the canonical helper or document why this case is intentionally separate.`);
}

function formatKnip(output) {
  const lines = output.split("\n");
  const instructions = [];
  let section = "";
  for (const line of lines) {
    const heading = line.match(/^(Unused files|Unused dependencies|Unused devDependencies|Unlisted dependencies|Unlisted binaries|Unused exports|Unused exported types)/);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!section || !line.trim() || line.startsWith("$ ")) continue;
    instructions.push(`${section}: ${line.trim()}. Confirm whether it is intentional, add config if it is an entry point, or remove/reuse it before tightening check:unused.`);
  }
  return instructions;
}

if (process.argv.includes("--files")) {
  printFiles();
  process.exit(0);
}

const results = CHECKS.map(run);
let blockingFailure = false;

for (const result of results) {
  const failed = result.status !== 0;
  if (failed && result.blocking) blockingFailure = true;
  const instructions = result.hint(result.output);
  const hasWarnings = !result.blocking && instructions.length > 0;
  let label;
  switch (true) {
    case failed && result.blocking:
      label = "BLOCK";
      break;
    case failed || hasWarnings:
      label = "WARN";
      break;
    default:
      label = "OK";
      break;
  }

  console.log(`\n[${label}] ${result.name}`);
  switch (true) {
    case instructions.length > 0:
      for (const instruction of instructions.slice(0, 20)) console.log(`- ${instruction}`);
      if (instructions.length > 20) console.log(`- ... ${instructions.length - 20} more finding(s) omitted`);
      break;
    case failed && result.output:
      console.log(result.output.split("\n").slice(0, 40).join("\n"));
      break;
    default:
      console.log("No findings.");
      break;
  }
}

process.exit(blockingFailure ? 1 : 0);
