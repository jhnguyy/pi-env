import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readNodeRequirement(repo = process.cwd()) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  return pkg.engines?.node ?? null;
}

export function readNodePin(path) {
  return readFileSync(path, 'utf8').trim();
}

export function minimumNodeVersion(repo = process.cwd()) {
  const requirement = readNodeRequirement(repo);
  if (!requirement) return null;
  return parseMinimumRequirement(requirement);
}

export function nodePolicyIssues(repo = process.cwd()) {
  const issues = [];
  const requirement = readNodeRequirement(repo);
  let minimum = null;
  try {
    minimum = minimumNodeVersion(repo);
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }

  const nodeVersion = readVersionFile(repo, '.node-version', issues);
  const nvmrc = readVersionFile(repo, '.nvmrc', issues);

  if (nodeVersion && nvmrc && nodeVersion !== nvmrc) {
    issues.push(`.node-version (${nodeVersion}) and .nvmrc (${nvmrc}) must match`);
  }

  if (nodeVersion && minimum) {
    const pinned = parseVersion(nodeVersion);
    if (pinned[0] !== minimum[0]) {
      issues.push(`.node-version (${nodeVersion}) and package.json engines.node (${requirement}) must use the same major`);
    } else if (compareSemver(pinned, minimum) < 0) {
      issues.push(`.node-version (${nodeVersion}) must satisfy package.json engines.node (${requirement})`);
    }
  }

  return issues;
}

export function assertNodePolicy(repo = process.cwd()) {
  const issues = nodePolicyIssues(repo);
  if (issues.length > 0) {
    throw new Error(`Node policy mismatch:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
  }
}

export function nodeVersionSatisfies(version, repo = process.cwd()) {
  const minimum = minimumNodeVersion(repo);
  if (!minimum) return true;
  return compareSemver(parseVersion(version), minimum) >= 0;
}

export function esbuildNodeTarget(repo = process.cwd()) {
  const minimum = minimumNodeVersion(repo);
  if (!minimum) return 'node24';
  const [major, minor] = minimum;
  return `node${major}.${minor}`;
}

function readVersionFile(repo, name, issues) {
  try {
    const version = readNodePin(join(repo, name));
    if (!parseVersionStrict(version)) {
      issues.push(`${name} must contain a plain semver version, found: ${version}`);
      return null;
    }
    return version;
  } catch (err) {
    issues.push(`Missing or unreadable ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseMinimumRequirement(range) {
  const minimum = parseMinimum(range);
  if (!minimum) {
    throw new Error(`Unsupported package.json engines.node range: ${range}`);
  }
  return minimum;
}

function parseMinimum(range) {
  const match = String(range).trim().match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function parseVersionStrict(version) {
  return String(version).match(/^\d+\.\d+\.\d+$/);
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
