#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  globSync,
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
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep as pathSeparator } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { licenseIdentifiers } from "./license-compliance-core.mjs";
import {
  loadDebianPolicy,
  parseDpkgQuery,
  validateDebianPackages,
  validateDebianSourceManifest,
} from "./debian-compliance-core.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));
const LEGAL_FILE_PATTERN = /^(?:(?:licen[cs]e|copying|notice)(?:$|[._ -])|third[-_ ]?party)/i;
const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:$|[._ -])/i;
const NOTICE_FILE_PATTERN = /^(?:notice(?:$|[._ -])|third[-_ ]?party)/i;

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
  return discoverStandardPackages(nodeModulesPath);
}

function containingNodeModules(packageRoot) {
  let parent = dirname(packageRoot);
  if (basename(parent).startsWith("@")) parent = dirname(parent);
  return basename(parent) === "node_modules" ? parent : undefined;
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
      const dependencyTree = containingNodeModules(realPackageRoot);
      if (dependencyTree !== undefined) pending.push(dependencyTree);
      const nested = join(realPackageRoot, "node_modules");
      if (existsSync(nested)) pending.push(nested);
    }
  }
  return [...packageRoots];
}

function workspacePatterns(manifest) {
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces;
  return isRecord(manifest.workspaces) && Array.isArray(manifest.workspaces.packages)
    ? manifest.workspaces.packages
    : [];
}

function workspaceNodeModulesPaths(repoRoot) {
  const manifestPath = join(repoRoot, "package.json");
  if (!existsSync(manifestPath)) return [];
  const paths = new Set();
  for (const pattern of workspacePatterns(readJson(manifestPath))) {
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    for (const workspacePath of globSync(pattern, { cwd: repoRoot })) {
      const packagePath = resolve(repoRoot, workspacePath);
      const relativePath = relative(repoRoot, packagePath);
      if (relativePath === ".." || relativePath.startsWith(`..${pathSeparator}`)) continue;
      if (!existsSync(join(packagePath, "package.json"))) continue;
      paths.add(join(packagePath, "node_modules"));
    }
  }
  return [...paths];
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

function renderDebianSourceCode(sources) {
  const lines = [
    "# Debian corresponding source",
    "",
    "The image contains complete exact source artifacts for every installed Debian source package.",
    "Each file was downloaded through the configured apt source indexes and is covered by a SHA-256 digest.",
    "",
  ];
  for (const source of sources) {
    lines.push(
      `## ${source.name}@${source.version}`,
      "",
      `- Artifacts: ${source.artifacts.map((artifact) => `/opt/pi-env/THIRD_PARTY_SOURCES/debian/${artifact.file}`).join(", ")}`,
      `- Packages: ${source.packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeDebianManifest(outputPath, packages, sources, copyrightRoot) {
  if (packages.length === 0) return;
  const records = packages.map((pkg) => ({
    ...pkg,
    copyright: `debian-copyright/${pkg.name}/copyright`,
  }));
  writeJson(join(outputPath, "debian-packages.json"), records);
  const copyrightOutput = join(outputPath, "debian-copyright");
  for (const pkg of packages) {
    const source = join(copyrightRoot, pkg.name, "copyright");
    if (!existsSync(source))
      throw new Error(`${pkg.name}@${pkg.version}: Debian copyright file is missing`);
    const destination = join(copyrightOutput, pkg.name);
    mkdirSync(destination, { recursive: true });
    copyFileSync(source, join(destination, "copyright"));
  }
  const lines = [
    "# Debian package manifest",
    "",
    "The image contains the following Debian binary packages and their installed copyright files.",
    "Every source package is covered by exact artifacts in /opt/pi-env/THIRD_PARTY_SOURCES/debian.",
    "",
    "| Package | Version | Source package | Source version | Copyright |",
    "| --- | --- | --- | --- | --- |",
    ...records.map(
      (pkg) =>
        `| ${markdownCell(pkg.name)} | ${markdownCell(pkg.version)} | ${markdownCell(pkg.source)} | ${markdownCell(pkg.sourceVersion)} | ${markdownCell(pkg.copyright)} |`,
    ),
    "",
  ];
  writeFileSync(join(outputPath, "DEBIAN_PACKAGES.md"), `${lines.join("\n")}\n`);
  writeFileSync(join(outputPath, "DEBIAN_SOURCE_CODE.md"), renderDebianSourceCode(sources));
  return records;
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

function validatePackages(packages, policy, errors) {
  for (const pkg of packages) {
    validateLicense(pkg, policy, errors);
    validateSourceRequirement(pkg, policy, errors);
  }
}

function resolvePackageLicenses(packages, policy, repoRoot, errors) {
  const donors = licenseDonors(packages);
  const resolved = [];
  for (const pkg of packages) {
    const source = resolveLicenseSource(pkg, donors, policy, repoRoot);
    if (source) resolved.push({ pkg, source });
    else errors.push(`${packageKey(pkg)}: no license text or reviewed override is available`);
  }
  return resolved;
}

function writePackageRecords(resolved, packageOutputPath) {
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
  return { records, missingOriginalLicenseText };
}

function copySystemLicenses(outputPath, systemLicenses) {
  if (systemLicenses.length === 0) return;
  const systemPath = join(outputPath, "system");
  mkdirSync(systemPath, { recursive: true });
  for (const entry of systemLicenses) copyFileSync(entry.path, join(systemPath, entry.name));
}

export function generateLicenseBundle({
  repoRoot = defaultRepoRoot,
  nodeModulesPath = join(repoRoot, "node_modules"),
  packageRoots = [],
  outputPath = join(repoRoot, "THIRD_PARTY_LICENSES"),
  policyPath = join(repoRoot, "compliance", "license-policy.json"),
  debianPolicyPath = join(repoRoot, "compliance", "debian-policy.json"),
  dpkgQueryPath,
  debianSourceManifestPath,
  debianCopyrightRoot = "/usr/share/doc",
  systemLicenses = [],
  validateRepository = false,
} = {}) {
  const policy = loadPolicy(policyPath);
  const debianPackages = dpkgQueryPath ? parseDpkgQuery(dpkgQueryPath) : [];
  const debianPolicy = debianPackages.length > 0 ? loadDebianPolicy(debianPolicyPath) : null;
  const discoveredRoots = [
    ...discoverNubPackages(nodeModulesPath),
    ...workspaceNodeModulesPaths(repoRoot).flatMap((path) => discoverStandardPackages(path)),
    ...packageRoots.flatMap((path) => discoverStandardPackages(path)),
  ];
  const packages = loadPackages(discoveredRoots);
  const errors = validateRepository ? validateRepositoryLicense(repoRoot) : [];
  if (debianPackages.length > 0 && debianPolicy)
    errors.push(...validateDebianPackages(debianPackages, debianPolicy));
  validatePackages(packages, policy, errors);
  const resolved = resolvePackageLicenses(packages, policy, repoRoot, errors);

  const debianSourceValidation =
    debianPackages.length > 0
      ? validateDebianSourceManifest(debianPackages, debianSourceManifestPath)
      : { errors: [], sources: [] };
  errors.push(...debianSourceValidation.errors);
  for (const pkg of debianPackages) {
    if (!existsSync(join(debianCopyrightRoot, pkg.name, "copyright"))) {
      errors.push(`${pkg.name}@${pkg.version}: Debian copyright file is missing`);
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));

  rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(outputPath, { recursive: true });
  const packageOutputPath = join(outputPath, "packages");
  mkdirSync(packageOutputPath, { recursive: true });

  const { records, missingOriginalLicenseText } = writePackageRecords(resolved, packageOutputPath);

  const debianPackageRecords =
    writeDebianManifest(
      outputPath,
      debianPackages,
      debianSourceValidation.sources,
      debianCopyrightRoot,
    ) ?? [];

  copySystemLicenses(outputPath, systemLicenses);

  const manifest = {
    schemaVersion: 1,
    javascriptPackages: records,
    debianPackages: debianPackageRecords,
    debianSources: debianSourceValidation.sources,
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

const PATH_OPTION_FIELDS = new Map([
  ["--repo-root", "repoRoot"],
  ["--node-modules", "nodeModulesPath"],
  ["--output", "outputPath"],
  ["--policy", "policyPath"],
  ["--debian-policy", "debianPolicyPath"],
  ["--dpkg-query", "dpkgQueryPath"],
  ["--debian-source-manifest", "debianSourceManifestPath"],
  ["--debian-copyright-root", "debianCopyrightRoot"],
]);

function parseSystemLicense(specification) {
  const separator = specification.indexOf("=");
  if (separator <= 0) throw new Error(`Invalid system license: ${specification}`);
  return {
    name: specification.slice(0, separator),
    path: resolve(specification.slice(separator + 1)),
  };
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
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    index += 1;
    if (index >= args.length) throw new Error(`Missing value for ${arg}`);
    const value = args[index];
    if (arg === "--package-root") options.packageRoots.push(resolve(value));
    else if (arg === "--system-license") options.systemLicenses.push(parseSystemLicense(value));
    else {
      const field = PATH_OPTION_FIELDS.get(arg);
      if (!field) throw new Error(`Unknown argument: ${arg}`);
      options[field] = resolve(value);
    }
  }
  options.nodeModulesPath ??= join(options.repoRoot, "node_modules");
  options.policyPath ??= join(options.repoRoot, "compliance", "license-policy.json");
  options.debianPolicyPath ??= join(options.repoRoot, "compliance", "debian-policy.json");
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
      `${action} for ${manifest.javascriptPackages.length} JavaScript packages and ${manifest.debianPackages.length} Debian packages.`,
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
