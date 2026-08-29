import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadDebianPolicy(path) {
  const policy = readJson(path);
  if (!Array.isArray(policy.packages) || policy.packages.length === 0) {
    throw new Error(`Invalid Debian package policy: ${path}`);
  }
  return policy;
}

export function parseDpkgQuery(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 4 || fields.some((field) => field === "")) {
        throw new Error(`Invalid dpkg-query record: ${line}`);
      }
      const binaryName = fields[0].replace(/:[^:]+$/, "");
      return {
        name: binaryName,
        version: fields[1],
        source: fields[2],
        sourceVersion: fields[3],
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function validateDebianPackages(packages, policy) {
  const errors = [];
  const approved = new Map();
  for (const entry of policy.packages) {
    if (!entry || typeof entry.name !== "string" || typeof entry.source !== "string") {
      errors.push("Debian policy contains an invalid package entry");
      continue;
    }
    if (approved.has(entry.name)) {
      errors.push(`Debian policy contains a duplicate package: ${entry.name}`);
      continue;
    }
    approved.set(entry.name, entry.source);
  }
  const installed = new Set();
  for (const pkg of packages) {
    installed.add(pkg.name);
    const source = approved.get(pkg.name);
    if (source === undefined) {
      errors.push(`${pkg.name}@${pkg.version}: Debian package is not approved`);
    } else if (source !== pkg.source) {
      errors.push(
        `${pkg.name}@${pkg.version}: Debian source changed from ${source} to ${pkg.source}`,
      );
    }
  }
  for (const name of approved.keys()) {
    if (!installed.has(name)) errors.push(`${name}: approved Debian package is not installed`);
  }
  return errors;
}

export function planDebianSources(packages) {
  const sources = new Map();
  for (const pkg of packages) {
    const key = `${pkg.source}\n${pkg.sourceVersion}`;
    const source = sources.get(key) ?? {
      name: pkg.source,
      version: pkg.sourceVersion,
      packages: [],
    };
    source.packages.push({ name: pkg.name, version: pkg.version });
    sources.set(key, source);
  }
  return [...sources.values()]
    .map((source) => ({
      ...source,
      packages: source.packages.sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    );
}

function safeArtifactPath(manifestPath, artifact) {
  if (!artifact || typeof artifact.file !== "string" || isAbsolute(artifact.file)) return null;
  const base = dirname(manifestPath);
  const path = resolve(base, artifact.file);
  const fromBase = relative(base, path);
  return fromBase === ".." || fromBase.startsWith("../") ? null : path;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sourceKey(source) {
  return `${source.name}\n${source.version}`;
}

function artifactsAreValid(source, manifestPath, errors) {
  if (!Array.isArray(source.artifacts) || source.artifacts.length === 0) {
    errors.push(`${source.name}@${source.version}: source artifacts are missing`);
    return false;
  }
  let valid = true;
  for (const artifact of source.artifacts) {
    const path = safeArtifactPath(manifestPath, artifact);
    if (!path || !existsSync(path)) {
      errors.push(
        `${source.name}: Debian source artifact is missing: ${artifact?.file ?? "unknown"}`,
      );
      valid = false;
    } else if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || sha256(path) !== artifact.sha256) {
      errors.push(
        `${source.name}: Debian source artifact checksum does not match: ${artifact.file}`,
      );
      valid = false;
    }
  }
  return valid;
}

function packageCoverageMatches(source, expected) {
  if (!Array.isArray(source.packages) || source.packages.length !== expected.packages.length) {
    return false;
  }
  const actual = new Set(source.packages.map((pkg) => `${pkg.name}\n${pkg.version}`));
  return expected.packages.every((pkg) => actual.has(`${pkg.name}\n${pkg.version}`));
}

function validateSource(source, expected, manifestPath, errors) {
  const artifactsValid = artifactsAreValid(source, manifestPath, errors);
  const packagesValid = packageCoverageMatches(source, expected);
  if (!packagesValid) {
    errors.push(`${source.name}@${source.version}: binary package coverage does not match`);
  }
  return artifactsValid && packagesValid;
}

export function validateDebianSourceManifest(packages, manifestPath) {
  const required = planDebianSources(packages);
  if (!manifestPath || !existsSync(manifestPath)) {
    return { errors: ["Debian source manifest is missing"], sources: [] };
  }
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.debianSources)) {
    return { errors: [`Invalid Debian source manifest: ${manifestPath}`], sources: [] };
  }
  const errors = [];
  const sources = [];
  const requiredByKey = new Map(required.map((source) => [sourceKey(source), source]));
  const seen = new Set();
  if (manifest.debianSources.length !== required.length) {
    errors.push(
      `Debian source manifest has ${manifest.debianSources.length} source units, expected ${required.length}`,
    );
  }
  for (const source of manifest.debianSources) {
    const key = sourceKey(source);
    if (seen.has(key)) {
      errors.push(`Debian source manifest contains a duplicate source unit: ${source.name}`);
      continue;
    }
    seen.add(key);
    const expected = requiredByKey.get(key);
    if (!expected) {
      errors.push(`${source.name}@${source.version}: source unit is not expected`);
      continue;
    }
    if (validateSource(source, expected, manifestPath, errors)) sources.push(source);
  }
  const validKeys = new Set(sources.map(sourceKey));
  for (const source of required) {
    if (!validKeys.has(sourceKey(source))) {
      errors.push(`${source.name}@${source.version}: exact Debian source is missing`);
    }
  }
  return { errors, sources };
}
