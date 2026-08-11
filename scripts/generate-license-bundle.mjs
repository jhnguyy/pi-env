#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));
const LEGAL_FILE_PATTERN = /^(?:(?:licen[cs]e|copying|notice)(?:$|[._ -])|third[-_ ]?party)/i;
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:$|[._ -])/i;
const NOTICE_FILE_PATTERN = /^(?:notice(?:$|[._ -])|third[-_ ]?party)/i;
const SPDX_OPERATOR = new Set(["AND", "OR", "WITH"]);
const SOURCE_REQUIRED_LICENSE_PREFIXES = ["AGPL-", "GPL-", "LGPL-"];
const ALPINE_APORTS_SECTIONS = ["main", "community", "testing"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageKey(pkg) {
  return `${pkg.name}@${pkg.version}`;
}

function packageDirectoryName(pkg) {
  return packageKey(pkg)
    .replaceAll("@", "_")
    .replaceAll("/", "+")
    .replaceAll(/[^A-Za-z0-9._+-]/g, "_");
}

function markdownCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function normalizeRepository(repository) {
  let value = repository;
  if (isRecord(value)) value = value.url;
  if (typeof value !== "string") return "";

  value = value
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/");
  if (/^github\.com\//i.test(value)) value = `https://${value}`;
  return value
    .replace(/\.git(?:#.*)?$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function displayRepository(repository) {
  let value = repository;
  if (isRecord(value)) value = value.url;
  return typeof value === "string" ? value.replace(/^git\+/, "") : "";
}

function licenseExpression(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim() !== "") return pkg.license.trim();
  if (isRecord(pkg.license) && typeof pkg.license.type === "string") return pkg.license.type.trim();
  return "";
}

export function licenseIdentifiers(expression) {
  return expression
    .replaceAll(/[()]/g, " ")
    .split(/\s+/)
    .filter((token) => token !== "" && !SPDX_OPERATOR.has(token));
}

function legalFiles(packageRoot) {
  if (!existsSync(packageRoot)) return [];
  return readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGAL_FILE_PATTERN.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: join(packageRoot, entry.name),
      type: NOTICE_FILE_PATTERN.test(entry.name) ? "notice" : "license",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function isDirectoryEntry(entry, path) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function immediatePackageRoots(nodeModulesPath) {
  if (!existsSync(nodeModulesPath)) return [];
  const roots = [];
  for (const entry of readdirSync(nodeModulesPath, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".nub") continue;
    const entryPath = join(nodeModulesPath, entry.name);
    if (!isDirectoryEntry(entry, entryPath)) continue;
    if (entry.name.startsWith("@")) {
      for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
        const packageRoot = join(entryPath, scopedEntry.name);
        if (!isDirectoryEntry(scopedEntry, packageRoot)) continue;
        if (existsSync(join(packageRoot, "package.json"))) roots.push(packageRoot);
      }
      continue;
    }
    if (existsSync(join(entryPath, "package.json"))) roots.push(entryPath);
  }
  return roots;
}

export function discoverNubPackages(nodeModulesPath) {
  const virtualStorePath = join(nodeModulesPath, ".nub");
  if (!existsSync(virtualStorePath)) {
    throw new Error(`Nub virtual store is missing: ${virtualStorePath}`);
  }

  const packageRoots = new Set();
  for (const entry of readdirSync(virtualStorePath, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = join(virtualStorePath, entry.name);
    let target;
    try {
      target = realpathSync(entryPath);
    } catch {
      continue;
    }
    for (const packageRoot of immediatePackageRoots(join(target, "node_modules"))) {
      packageRoots.add(realpathSync(packageRoot));
    }
  }
  return [...packageRoots];
}

export function discoverStandardPackages(nodeModulesPath) {
  const packageRoots = new Set();
  const pending = [nodeModulesPath];
  const visitedNodeModules = new Set();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !existsSync(current)) continue;
    const realCurrent = realpathSync(current);
    if (visitedNodeModules.has(realCurrent)) continue;
    visitedNodeModules.add(realCurrent);

    for (const packageRoot of immediatePackageRoots(realCurrent)) {
      const realPackageRoot = realpathSync(packageRoot);
      packageRoots.add(realPackageRoot);
      const nested = join(realPackageRoot, "node_modules");
      if (existsSync(nested)) pending.push(nested);
    }
  }
  return [...packageRoots];
}

function loadPackages(packageRoots) {
  const packages = new Map();
  for (const packageRoot of packageRoots) {
    const manifestPath = join(packageRoot, "package.json");
    const manifest = readJson(manifestPath);
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`Installed package manifest is missing name or version: ${manifestPath}`);
    }
    const record = {
      name: manifest.name,
      version: manifest.version,
      license: licenseExpression(manifest),
      repository: displayRepository(manifest.repository),
      normalizedRepository: normalizeRepository(manifest.repository),
      author: manifest.author ?? null,
      root: packageRoot,
      legalFiles: legalFiles(packageRoot),
    };
    const key = packageKey(record);
    const prior = packages.get(key);
    if (!prior || prior.legalFiles.length < record.legalFiles.length) packages.set(key, record);
  }
  return [...packages.values()].sort((left, right) =>
    packageKey(left).localeCompare(packageKey(right)),
  );
}

export function loadPolicy(policyPath) {
  const policy = readJson(policyPath);
  if (
    !Array.isArray(policy.allowedLicenseIds) ||
    !Array.isArray(policy.prohibitedLicensePrefixes)
  ) {
    throw new Error(`Invalid license policy: ${policyPath}`);
  }
  return {
    ...policy,
    overrides: Array.isArray(policy.overrides) ? policy.overrides : [],
    sourceRepositories: Array.isArray(policy.sourceRepositories) ? policy.sourceRepositories : [],
  };
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

function validateLicense(pkg, policy, errors) {
  if (pkg.license === "") {
    errors.push(`${packageKey(pkg)}: package license metadata is missing`);
    return;
  }

  const identifiers = licenseIdentifiers(pkg.license);
  if (identifiers.length === 0) {
    errors.push(`${packageKey(pkg)}: package license expression is invalid: ${pkg.license}`);
    return;
  }

  for (const identifier of identifiers) {
    if (policy.prohibitedLicensePrefixes.some((prefix) => identifier.startsWith(prefix))) {
      errors.push(`${packageKey(pkg)}: prohibited license: ${identifier}`);
      continue;
    }
    if (!policy.allowedLicenseIds.includes(identifier)) {
      errors.push(`${packageKey(pkg)}: unapproved license identifier: ${identifier}`);
    }
  }
}

function licenseDonors(packages) {
  const donors = new Map();
  for (const pkg of packages) {
    if (pkg.normalizedRepository === "") continue;
    const files = pkg.legalFiles.filter((file) => LICENSE_FILE_PATTERN.test(file.name));
    if (files.length === 0) continue;
    const key = `${pkg.normalizedRepository}\n${pkg.license}`;
    const records = donors.get(key) ?? [];
    records.push(pkg);
    donors.set(key, records);
  }
  for (const records of donors.values()) {
    records.sort((left, right) => packageKey(left).localeCompare(packageKey(right)));
  }
  return donors;
}

function matchingOverride(pkg, policy, repoRoot) {
  return policy.overrides.find((candidate) => {
    if (normalizeRepository(candidate.repository) !== pkg.normalizedRepository) return false;
    if (candidate.license !== pkg.license) return false;
    if (!Array.isArray(candidate.versions) || !candidate.versions.includes(pkg.version))
      return false;
    return typeof candidate.file === "string" && existsSync(resolve(repoRoot, candidate.file));
  });
}

function resolveLicenseSource(pkg, donors, policy, repoRoot) {
  const ownLicenseFiles = pkg.legalFiles.filter((file) => LICENSE_FILE_PATTERN.test(file.name));
  if (ownLicenseFiles.length > 0) {
    return { type: "package", package: packageKey(pkg), files: ownLicenseFiles };
  }

  const donorKey = `${pkg.normalizedRepository}\n${pkg.license}`;
  const candidates = donors.get(donorKey) ?? [];
  const donor = candidates.find((candidate) => candidate.version === pkg.version);
  if (donor) {
    return {
      type: "repository-package",
      package: packageKey(donor),
      files: donor.legalFiles.filter((file) => LICENSE_FILE_PATTERN.test(file.name)),
    };
  }

  const override = matchingOverride(pkg, policy, repoRoot);
  if (override) {
    return {
      type: "reviewed-override",
      package: null,
      files: [
        { name: basename(override.file), path: resolve(repoRoot, override.file), type: "license" },
      ],
    };
  }

  return null;
}

function matchingSourceRepository(pkg, policy) {
  const normalizedRepository = pkg.normalizedRepository ?? normalizeRepository(pkg.repository);
  return policy.sourceRepositories.find(
    (candidate) =>
      normalizeRepository(candidate.repository) === normalizedRepository &&
      Array.isArray(candidate.versions) &&
      candidate.versions.includes(pkg.version) &&
      typeof candidate.reference === "string" &&
      candidate.reference.includes("{revision}") &&
      typeof candidate.revision === "string" &&
      /^[0-9a-f]{40}$/i.test(candidate.revision),
  );
}

function validateSourceRequirement(pkg, policy, errors) {
  const requiresSource = licenseIdentifiers(pkg.license).some((identifier) =>
    (policy.sourceRequiredLicenseIds ?? []).includes(identifier),
  );
  if (requiresSource && !matchingSourceRepository(pkg, policy)) {
    errors.push(`${packageKey(pkg)}: exact source reference is required for ${pkg.license}`);
  }
}

function sourceCodeReference(pkg, policy) {
  const source = matchingSourceRepository(pkg, policy);
  if (!source) throw new Error(`${packageKey(pkg)}: exact source reference is missing`);
  return source.reference
    .replaceAll("{version}", pkg.version)
    .replaceAll("{revision}", source.revision);
}

function copyLegalFile(file, targetDirectory, targetName) {
  const sourceStat = lstatSync(file.path);
  if (!sourceStat.isFile()) throw new Error(`Legal file is not a regular file: ${file.path}`);
  copyFileSync(file.path, join(targetDirectory, targetName));
}

function renderNoticeManifest(records, missingOriginalLicenseText) {
  const licenseCounts = new Map();
  for (const record of records) {
    licenseCounts.set(record.license, (licenseCounts.get(record.license) ?? 0) + 1);
  }

  const lines = [
    "# JavaScript third-party notices",
    "",
    "This directory contains notices for the JavaScript packages installed in this artifact.",
    "The package list comes from the installed package tree, not only from declared dependencies.",
    "",
    "## License summary",
    "",
    "| License expression | Packages |",
    "| --- | ---: |",
    ...[...licenseCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([license, count]) => `| ${markdownCell(license)} | ${count} |`),
    "",
    "## Packages",
    "",
    "| Package | License | Repository | License source |",
    "| --- | --- | --- | --- |",
    ...records.map(
      (record) =>
        `| ${markdownCell(`${record.name}@${record.version}`)} | ${markdownCell(record.license)} | ${markdownCell(record.repository)} | ${markdownCell(record.licenseSource.type)} |`,
    ),
    "",
    "## Packages without an upstream license file",
    "",
    "The following packages did not contain a license file in their installed package root.",
    "The bundle uses a same-repository package license or a reviewed override for these packages.",
    "",
    ...(missingOriginalLicenseText.length === 0
      ? ["None."]
      : missingOriginalLicenseText.map((record) => `- ${record}`)),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function renderSourceCode(records, policy) {
  const sourceRequired = records.filter((record) =>
    licenseIdentifiers(record.license).some((identifier) =>
      (policy.sourceRequiredLicenseIds ?? []).includes(identifier),
    ),
  );
  const lines = [
    "# Corresponding source",
    "",
    "The following JavaScript packages require source-code availability when executable forms are distributed.",
    "The listed version and source reference identify the corresponding upstream source.",
    "",
  ];
  if (sourceRequired.length === 0) lines.push("None.", "");
  else {
    for (const record of sourceRequired) {
      lines.push(
        `## ${record.name}@${record.version}`,
        "",
        `- License: ${record.license}`,
        `- Source: ${sourceCodeReference(record, policy)}`,
        "- Local modifications: none",
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
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

function renderAlpineSourceCode(sources) {
  const lines = [
    "# Alpine corresponding source",
    "",
    "The image contains complete corresponding-source archives for source-required Alpine packages.",
    "Each archive comes from the exact Alpine build commit and contains the APKBUILD, local patches, and fetched upstream source files.",
    "",
  ];
  for (const source of sources) {
    lines.push(
      `## ${source.origin}`,
      "",
      `- Build commit: ${source.buildCommit}`,
      `- Aports path: ${source.recipePath}`,
      `- Archive: /opt/pi-env/THIRD_PARTY_SOURCES/alpine/${source.archive}`,
      `- SHA-256: ${source.sha256}`,
      `- Packages: ${source.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeApkManifest(outputPath, apkPackages, alpineSources) {
  if (apkPackages.length === 0) return;
  writeJson(join(outputPath, "alpine-packages.json"), apkPackages);
  const lines = [
    "# Alpine package source and license manifest",
    "",
    "The image contains the following Alpine packages.",
    "The installed package database supplies each exact version, license expression, source origin, and build commit.",
    "Source-required packages are covered by archives in /opt/pi-env/THIRD_PARTY_SOURCES/alpine.",
    "",
    "| Package | Version | License | Origin | Build recipe | Upstream |",
    "| --- | --- | --- | --- | --- | --- |",
    ...apkPackages.map(
      (pkg) =>
        `| ${markdownCell(pkg.name)} | ${markdownCell(pkg.version)} | ${markdownCell(pkg.license)} | ${markdownCell(pkg.origin)} | ${markdownCell(pkg.buildRecipe)} | ${markdownCell(pkg.homepage)} |`,
    ),
    "",
    "Alpine build recipes: https://gitlab.alpinelinux.org/alpine/aports",
    "",
  ];
  writeFileSync(join(outputPath, "ALPINE_PACKAGES.md"), `${lines.join("\n")}\n`);
  if (alpineSources.length > 0) {
    writeFileSync(join(outputPath, "ALPINE_SOURCE_CODE.md"), renderAlpineSourceCode(alpineSources));
  }
}

function validateRepositoryLicense(repoRoot) {
  const errors = [];
  for (const required of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    if (!existsSync(join(repoRoot, required)))
      errors.push(`repository license file is missing: ${required}`);
  }

  const manifests = [join(repoRoot, "package.json")];
  const extensionsPath = join(repoRoot, ".pi", "extensions");
  if (existsSync(extensionsPath)) {
    for (const entry of readdirSync(extensionsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(extensionsPath, entry.name, "package.json");
      if (existsSync(manifestPath)) manifests.push(manifestPath);
    }
  }

  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    if (manifest.license !== "MIT") {
      errors.push(`${relative(repoRoot, manifestPath)}: package license must be MIT`);
    }
  }
  return errors;
}

export function generateLicenseBundle({
  repoRoot = defaultRepoRoot,
  nodeModulesPath = join(repoRoot, "node_modules"),
  packageRoots = [],
  outputPath = join(repoRoot, "THIRD_PARTY_LICENSES"),
  policyPath = join(repoRoot, "compliance", "license-policy.json"),
  alpinePolicyPath = join(repoRoot, "compliance", "alpine-policy.json"),
  apkDbPath,
  alpineSourceManifestPath,
  systemLicenses = [],
  validateRepository = false,
} = {}) {
  const policy = loadPolicy(policyPath);
  const apkPackages = apkDbPath ? parseApkInstalled(apkDbPath) : [];
  const alpinePolicy =
    apkPackages.length > 0 || existsSync(alpinePolicyPath)
      ? loadAlpinePolicy(alpinePolicyPath)
      : null;
  const discoveredRoots = [
    ...discoverNubPackages(nodeModulesPath),
    ...packageRoots.flatMap((path) => discoverStandardPackages(path)),
  ];
  const packages = loadPackages(discoveredRoots);
  const errors = validateRepository ? validateRepositoryLicense(repoRoot) : [];
  if (apkPackages.length > 0 && alpinePolicy)
    errors.push(...validateAlpinePackages(apkPackages, alpinePolicy));
  for (const pkg of packages) {
    validateLicense(pkg, policy, errors);
    validateSourceRequirement(pkg, policy, errors);
  }

  const donors = licenseDonors(packages);
  const resolved = [];
  for (const pkg of packages) {
    const source = resolveLicenseSource(pkg, donors, policy, repoRoot);
    if (!source)
      errors.push(`${packageKey(pkg)}: no license text or reviewed override is available`);
    else resolved.push({ pkg, source });
  }

  const alpineSourceValidation =
    apkPackages.length > 0 && alpinePolicy
      ? validateAlpineSourceManifest(apkPackages, alpinePolicy, alpineSourceManifestPath)
      : { errors: [], sources: [] };
  errors.push(...alpineSourceValidation.errors);

  if (errors.length > 0) throw new Error(errors.join("\n"));

  rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(outputPath, { recursive: true });
  const packageOutputPath = join(outputPath, "packages");
  mkdirSync(packageOutputPath, { recursive: true });

  const records = [];
  const missingOriginalLicenseText = [];
  for (const { pkg, source } of resolved) {
    const targetDirectory = join(packageOutputPath, packageDirectoryName(pkg));
    mkdirSync(targetDirectory, { recursive: true });
    const copiedFiles = [];

    for (const file of source.files) {
      const targetName =
        source.type === "package"
          ? file.name
          : `LICENSE.from-${packageDirectoryName({ name: source.package ?? "override", version: "source" })}-${file.name}`;
      copyLegalFile(file, targetDirectory, targetName);
      copiedFiles.push(targetName);
    }
    for (const file of pkg.legalFiles.filter((candidate) => candidate.type === "notice")) {
      copyLegalFile(file, targetDirectory, file.name);
      copiedFiles.push(file.name);
    }

    const hasOwnLicense = pkg.legalFiles.some((file) => LICENSE_FILE_PATTERN.test(file.name));
    if (!hasOwnLicense) missingOriginalLicenseText.push(packageKey(pkg));
    records.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repository: pkg.repository,
      author: pkg.author,
      upstreamLicenseTextMissing: !hasOwnLicense,
      licenseSource: { type: source.type, package: source.package },
      files: copiedFiles.sort(),
    });
  }

  writeApkManifest(outputPath, apkPackages, alpineSourceValidation.sources);

  if (systemLicenses.length > 0) {
    const systemPath = join(outputPath, "system");
    mkdirSync(systemPath, { recursive: true });
    for (const entry of systemLicenses) {
      copyFileSync(entry.path, join(systemPath, entry.name));
    }
  }

  const manifest = {
    schemaVersion: 1,
    javascriptPackages: records,
    alpinePackages: apkPackages,
    alpineSources: alpineSourceValidation.sources,
    systemLicenses: systemLicenses.map((entry) => entry.name).sort(),
  };
  writeJson(join(outputPath, "manifest.json"), manifest);
  writeFileSync(
    join(outputPath, "THIRD_PARTY_NOTICES.md"),
    renderNoticeManifest(records, missingOriginalLicenseText),
  );
  writeFileSync(join(outputPath, "SOURCE_CODE.md"), renderSourceCode(records, policy));
  return manifest;
}

function parseArgs(args) {
  const options = {
    repoRoot: defaultRepoRoot,
    packageRoots: [],
    systemLicenses: [],
    check: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      index += 1;
      if (index >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[index];
    };
    if (arg === "--check") options.check = true;
    else if (arg === "--repo-root") options.repoRoot = resolve(value());
    else if (arg === "--node-modules") options.nodeModulesPath = resolve(value());
    else if (arg === "--package-root") options.packageRoots.push(resolve(value()));
    else if (arg === "--output") options.outputPath = resolve(value());
    else if (arg === "--policy") options.policyPath = resolve(value());
    else if (arg === "--alpine-policy") options.alpinePolicyPath = resolve(value());
    else if (arg === "--apk-db") options.apkDbPath = resolve(value());
    else if (arg === "--alpine-source-manifest")
      options.alpineSourceManifestPath = resolve(value());
    else if (arg === "--system-license") {
      const specification = value();
      const separator = specification.indexOf("=");
      if (separator <= 0) throw new Error(`Invalid system license: ${specification}`);
      options.systemLicenses.push({
        name: specification.slice(0, separator),
        path: resolve(specification.slice(separator + 1)),
      });
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  options.nodeModulesPath ??= join(options.repoRoot, "node_modules");
  options.policyPath ??= join(options.repoRoot, "compliance", "license-policy.json");
  options.alpinePolicyPath ??= join(options.repoRoot, "compliance", "alpine-policy.json");
  options.outputPath ??= join(options.repoRoot, "THIRD_PARTY_LICENSES");
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let checkDirectory;
  if (options.check) {
    checkDirectory = mkdtempSync(join(tmpdir(), "pi-env-license-check-"));
    options.outputPath = join(checkDirectory, "THIRD_PARTY_LICENSES");
  }
  try {
    const manifest = generateLicenseBundle({ ...options, validateRepository: true });
    const action = options.check ? "License compliance check passed" : "Generated license bundle";
    console.log(
      `${action} for ${manifest.javascriptPackages.length} JavaScript packages and ${manifest.alpinePackages.length} Alpine packages.`,
    );
  } finally {
    if (checkDirectory) rmSync(checkDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
