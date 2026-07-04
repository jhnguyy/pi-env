import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const ExtensionRuntime = Object.freeze({
  SourceEntry: "index.ts",
  BundleEntry: "dist/index.js",
  PackageRuntimeEntry: "./dist/index.js",
});

export const DEFAULT_DISABLED_EXTENSIONS = Object.freeze(["playwright-client"]);

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function normalizePackagePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function extensionNameFromPath(path) {
  return posix.basename(normalizePackagePath(path));
}

export function extensionAbsPath(root, packagePath) {
  return join(root, ...normalizePackagePath(packagePath).split("/"));
}

export function extensionPaths(root, packagePath) {
  const normalized = normalizePackagePath(packagePath);
  const absPath = extensionAbsPath(root, normalized);
  return {
    packagePath: normalized,
    absPath,
    packageJson: join(absPath, "package.json"),
    sourceEntry: join(absPath, ExtensionRuntime.SourceEntry),
    bundleEntry: join(absPath, ExtensionRuntime.BundleEntry),
  };
}

export function normalizedPathSet(paths = []) {
  return new Set(paths.map((path) => normalizePackagePath(path)));
}

function loadExtensionPackage(paths) {
  if (!existsSync(paths.packageJson)) return null;
  return loadJson(paths.packageJson);
}

function normalizeSidecars(config, name, absPath) {
  return (config.sidecars?.[name] ?? []).map((sidecar) => ({
    ...sidecar,
    absEntry: join(absPath, sidecar.entry),
    absOutfile: join(absPath, sidecar.outfile),
  }));
}

export function createExtensionRecord(root, config, packagePath) {
  const paths = extensionPaths(root, packagePath);
  const name = extensionNameFromPath(paths.packagePath);
  const packageJson = loadExtensionPackage(paths);
  return {
    name,
    ...paths,
    packageJson,
    runtimeEntries: packageJson?.pi?.extensions ?? [],
    sidecars: normalizeSidecars(config, name, paths.absPath),
    defaultDisabled: DEFAULT_DISABLED_EXTENSIONS.includes(name),
    hasPackageJson: packageJson !== null,
    hasSourceEntry: existsSync(paths.sourceEntry),
    hasBundleEntry: existsSync(paths.bundleEntry),
  };
}

export function loadExtensionManifest(root = repoRoot) {
  const packagePath = join(root, "package.json");
  const configPath = join(root, "pi-build.config.json");
  const pkg = loadJson(packagePath);
  const config = loadJson(configPath);
  const extensionsDir = normalizePackagePath(config.extensionsDir ?? ".pi/extensions");
  const packageExtensions = pkg.pi?.extensions ?? [];
  const workspacePaths = normalizedPathSet(pkg.workspaces ?? []);
  const extensions = packageExtensions
    .map((path) => normalizePackagePath(path))
    .filter((path) => path.startsWith(`${extensionsDir}/`))
    .map((path) => createExtensionRecord(root, config, path));
  return {
    repoRoot: root,
    pkg,
    config,
    extensionsDir,
    packageExtensions,
    workspacePaths,
    extensions,
    activeNames: new Set(extensions.map((ext) => ext.name)),
    activePackagePaths: new Set(extensions.map((ext) => ext.packagePath)),
  };
}

export function listExtensionDirs(extensionsDir, root = repoRoot) {
  const absDir = extensionAbsPath(root, extensionsDir);
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .map((name) => ({ name, absPath: join(absDir, name) }))
    .filter((entry) => statSync(entry.absPath).isDirectory());
}

export function relativeFromRepo(absPath, root = repoRoot) {
  return absPath.replace(`${root}${sep}`, "").replaceAll("\\", "/");
}
