import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readNodeRequirement(repo = process.cwd()) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  return pkg.engines?.node ?? null;
}

export function minimumNodeVersion(repo = process.cwd()) {
  const requirement = readNodeRequirement(repo);
  if (!requirement) return null;
  const minimum = parseMinimum(requirement);
  if (!minimum) {
    throw new Error(`Unsupported package.json engines.node range: ${requirement}`);
  }
  return minimum;
}

export function nodeVersionSatisfies(version, repo = process.cwd()) {
  const minimum = minimumNodeVersion(repo);
  if (!minimum) return true;
  return compareSemver(parseVersion(version), minimum) >= 0;
}

export function esbuildNodeTarget(repo = process.cwd()) {
  const minimum = minimumNodeVersion(repo);
  if (!minimum) return 'node22';
  const [major, minor] = minimum;
  return `node${major}.${minor}`;
}

function parseMinimum(range) {
  const match = String(range).trim().match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function parseVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map((part) => Number(part) || 0);
  return [major, minor, patch];
}

function compareSemver(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}
