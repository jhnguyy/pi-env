import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readPackageJson(repo = process.cwd()) {
  return JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
}

export function readNodeRequirement(repo = process.cwd()) {
  return readPackageJson(repo).engines?.node ?? null;
}

export function minimumNodeVersion(repo = process.cwd()) {
  const requirement = readNodeRequirement(repo);
  if (!requirement) return null;
  const match = requirement.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Unsupported package.json engines.node range: ${requirement}`);
  return match.slice(1).map(Number);
}

export function nodePolicyIssues(repo = process.cwd()) {
  try {
    minimumNodeVersion(repo);
    return [];
  } catch (error) {
    return [error.message];
  }
}

export function assertNodePolicy(repo = process.cwd()) {
  const issues = nodePolicyIssues(repo);
  if (issues.length > 0) throw new Error(issues.join("\n"));
}

export function nodeVersionSatisfies(version, repo = process.cwd()) {
  const minimum = minimumNodeVersion(repo);
  if (!minimum) return true;
  const match = String(version).match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export function esbuildNodeTarget(repo = process.cwd()) {
  const minimum = minimumNodeVersion(repo);
  return minimum ? `node${minimum[0]}.${minimum[1]}` : "node24";
}
