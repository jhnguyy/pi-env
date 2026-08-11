import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const SPDX_OPERATOR = new Set(["AND", "OR", "WITH"]);
const SOURCE_REQUIRED_LICENSE_PREFIXES = ["AGPL-", "GPL-", "LGPL-"];
const ALPINE_APORTS_SECTIONS = ["main", "community", "testing"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function licenseIdentifiers(expression) {
  return expression
    .replaceAll(/[()]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "" && !SPDX_OPERATOR.has(token));
}

export function loadAlpinePolicy(policyPath) {
  const policy = readJson(policyPath);
  if (!Array.isArray(policy.packages) || !Array.isArray(policy.sourceRequiredLicenseIds)) {
    throw new Error(`Invalid Alpine license policy: ${policyPath}`);
  }
  for (const entry of policy.packages) {
    for (const expression of entry.licenseExpressions ?? []) {
      for (const identifier of licenseIdentifiers(expression)) {
        const sourceRequired =
          identifier === "MPL-2.0" ||
          SOURCE_REQUIRED_LICENSE_PREFIXES.some((prefix) => identifier.startsWith(prefix));
        if (sourceRequired && !policy.sourceRequiredLicenseIds.includes(identifier)) {
          throw new Error(
            `Invalid Alpine license policy: ${identifier} must require corresponding source`,
          );
        }
      }
    }
  }
  return policy;
}

export function validateAlpinePackages(packages, policy) {
  const errors = [];
  const approved = new Map();
  for (const entry of policy.packages) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      typeof entry.origin !== "string" ||
      !Array.isArray(entry.licenseExpressions) ||
      entry.licenseExpressions.length === 0
    ) {
      errors.push("Alpine policy contains an invalid package entry");
      continue;
    }
    if (approved.has(entry.name)) {
      errors.push(`Alpine policy contains a duplicate package: ${entry.name}`);
      continue;
    }
    approved.set(entry.name, entry);
  }

  const installedNames = new Set();
  for (const pkg of packages) {
    installedNames.add(pkg.name);
    const entry = approved.get(pkg.name);
    if (!entry) {
      errors.push(`${pkg.name}@${pkg.version}: Alpine package is not approved`);
      continue;
    }
    if (pkg.origin !== entry.origin) {
      errors.push(
        `${pkg.name}@${pkg.version}: Alpine origin changed from ${entry.origin} to ${pkg.origin}`,
      );
    }
    if (!entry.licenseExpressions.includes(pkg.license)) {
      errors.push(
        `${pkg.name}@${pkg.version}: Alpine license expression is not approved: ${pkg.license}`,
      );
    }
  }

  for (const name of approved.keys()) {
    if (!installedNames.has(name)) errors.push(`${name}: approved Alpine package is not installed`);
  }
  return errors;
}

export function alpinePackageRequiresSource(pkg, policy) {
  return licenseIdentifiers(pkg.license).some((identifier) =>
    policy.sourceRequiredLicenseIds.includes(identifier),
  );
}

export function planAlpineSources(packages, policy) {
  const grouped = new Map();
  for (const pkg of packages) {
    const key = `${pkg.origin}\n${pkg.buildCommit}`;
    const group = grouped.get(key) ?? {
      origin: pkg.origin,
      buildCommit: pkg.buildCommit,
      packages: [],
    };
    group.packages.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
    });
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .filter((group) => group.packages.some((pkg) => alpinePackageRequiresSource(pkg, policy)))
    .map((group) => ({
      ...group,
      packages: group.packages.sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) =>
      `${left.origin}@${left.buildCommit}`.localeCompare(`${right.origin}@${right.buildCommit}`),
    );
}

export function parseApkInstalled(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const fields = new Map();
      for (const line of block.split("\n")) {
        const separator = line.indexOf(":");
        if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1));
      }
      return {
        name: fields.get("P") ?? "",
        version: fields.get("V") ?? "",
        license: fields.get("L") ?? "",
        origin: fields.get("o") ?? "",
        buildCommit: fields.get("c") ?? "",
        buildRecipe: fields.has("c")
          ? `https://gitlab.alpinelinux.org/alpine/aports/-/commit/${fields.get("c")}`
          : "",
        homepage: fields.get("U") ?? "",
      };
    })
    .filter((pkg) => pkg.name !== "")
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeManifestArchivePath(manifestPath, archive) {
  if (typeof archive !== "string" || archive === "" || isAbsolute(archive)) return null;
  const base = dirname(manifestPath);
  const archivePath = resolve(base, archive);
  const fromBase = relative(base, archivePath);
  if (fromBase === ".." || fromBase.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    return null;
  return archivePath;
}

export function validateAlpineSourceManifest(packages, policy, manifestPath) {
  const required = planAlpineSources(packages, policy);
  if (required.length === 0) return { errors: [], sources: [] };
  if (!manifestPath || !existsSync(manifestPath)) {
    return { errors: ["Alpine corresponding-source manifest is missing"], sources: [] };
  }

  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)) {
    return { errors: [`Invalid Alpine source manifest: ${manifestPath}`], sources: [] };
  }

  const errors = [];
  const sources = [];
  const seen = new Set();
  const requiredByKey = new Map(
    required.map((group) => [`${group.origin}\n${group.buildCommit}`, group]),
  );
  if (manifest.sources.length !== required.length) {
    errors.push(
      `Alpine source manifest has ${manifest.sources.length} source units, expected ${required.length}`,
    );
  }
  for (const source of manifest.sources) {
    const key = `${source.origin}\n${source.buildCommit}`;
    if (seen.has(key)) {
      errors.push(`Alpine source manifest contains a duplicate source unit: ${source.origin}`);
      continue;
    }
    seen.add(key);
    const requiredGroup = requiredByKey.get(key);
    if (!requiredGroup) {
      errors.push(`${source.origin}@${source.buildCommit}: source unit is not expected`);
      continue;
    }
    const validRecipePaths = ALPINE_APORTS_SECTIONS.map((section) => `${section}/${source.origin}`);
    if (!validRecipePaths.includes(source.recipePath)) {
      errors.push(`${source.origin}@${source.buildCommit}: aports recipe path is invalid`);
      continue;
    }
    const archivePath = safeManifestArchivePath(manifestPath, source.archive);
    if (!archivePath || !existsSync(archivePath)) {
      errors.push(`${source.origin}: Alpine corresponding-source archive is missing`);
      continue;
    }
    const actualSha256 = sha256File(archivePath);
    if (source.sha256 !== actualSha256) {
      errors.push(`${source.origin}: Alpine corresponding-source archive checksum does not match`);
      continue;
    }
    sources.push(source);
  }

  for (const group of required) {
    if (!/^[0-9a-f]{40}$/i.test(group.buildCommit)) {
      errors.push(
        `${group.origin}: exact Alpine build commit is required for corresponding source`,
      );
      continue;
    }
    const source = sources.find(
      (candidate) =>
        candidate.origin === group.origin && candidate.buildCommit === group.buildCommit,
    );
    if (!source) {
      errors.push(`${group.origin}@${group.buildCommit}: corresponding source is missing`);
      continue;
    }
    if (!Array.isArray(source.packages)) {
      errors.push(`${group.origin}@${group.buildCommit}: source package list is missing`);
      continue;
    }
    if (source.packages.length !== group.packages.length) {
      errors.push(`${group.origin}@${group.buildCommit}: source package list does not match`);
    }
    for (const pkg of group.packages) {
      const covered = source.packages.some(
        (candidate) =>
          candidate.name === pkg.name &&
          candidate.version === pkg.version &&
          candidate.license === pkg.license,
      );
      if (!covered) {
        errors.push(`${pkg.name}@${pkg.version}: corresponding-source coverage is missing`);
      }
    }
  }
  return { errors, sources };
}
