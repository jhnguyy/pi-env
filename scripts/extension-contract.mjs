import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  listExtensionDirs,
  loadExtensionManifest,
  normalizePackagePath,
  relativeFromRepo,
} from "./extension-manifest.mjs";

function normalizedPathSet(paths = []) {
  return new Set(paths.map((path) => normalizePackagePath(path)));
}

const DEFAULT_DISABLED_EXTENSIONS = new Set(["playwright-client"]);

function activeExtensionSets(extensions) {
  return {
    names: new Set(extensions.map((ext) => ext.name)),
    packagePaths: new Set(extensions.map((ext) => ext.packagePath)),
  };
}

function requireUniqueActiveExtensions(extensions, errors) {
  const seenNames = new Set();
  const seenPaths = new Set();
  for (const ext of extensions) {
    if (seenNames.has(ext.name)) {
      errors.push(`duplicate active extension name: ${ext.name}`);
    }
    if (seenPaths.has(ext.packagePath)) {
      errors.push(`duplicate active extension path: ${ext.packagePath}`);
    }
    seenNames.add(ext.name);
    seenPaths.add(ext.packagePath);
  }
}

function rejectDefaultDisabledActiveExtensions(extensions, errors) {
  for (const ext of extensions) {
    if (DEFAULT_DISABLED_EXTENSIONS.has(ext.name)) {
      errors.push(`${ext.name}: extension must stay disabled by default; do not register it in package pi.extensions`);
    }
  }
}

function requireBuiltExtension(ext, config, errors, root) {
  const entry = join(ext.absPath, "index.ts");
  const bundle = join(ext.absPath, "dist/index.js");
  const packageJsonPath = join(ext.absPath, "package.json");

  if (existsSync(packageJsonPath)) {
    const extPkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const exports = extPkg.pi?.extensions ?? [];
    if (!Array.isArray(exports) || !exports.includes("./dist/index.js")) {
      errors.push(`${ext.name}: package.json pi.extensions must include ./dist/index.js`);
    }
  }
  if (!existsSync(entry)) {
    errors.push(`${ext.name}: missing source entry ${relativeFromRepo(entry, root)}`);
  }
  if (!existsSync(bundle)) {
    errors.push(`${ext.name}: missing built bundle ${relativeFromRepo(bundle, root)}`);
  }
  for (const sidecar of config.sidecars?.[ext.name] ?? []) {
    const sidecarOut = join(ext.absPath, sidecar.outfile);
    if (!existsSync(sidecarOut)) {
      errors.push(`${ext.name}: missing built sidecar ${relativeFromRepo(sidecarOut, root)}`);
    }
  }
}

function requireRegisteredPackageFiles(pkg, errors, root) {
  for (const packagePath of pkg.pi?.extensions ?? []) {
    const normalized = normalizePackagePath(packagePath);
    const manifest = join(root, ...normalized.split("/"), "package.json");
    if (!existsSync(manifest)) {
      errors.push(`package extension is missing package.json: ${normalized}`);
    }
  }
}

function requireWorkspaceParity(pkg, extensionsDir, activePaths, extensions, errors) {
  const workspacePaths = normalizedPathSet(pkg.workspaces ?? []);

  for (const normalized of workspacePaths) {
    if (normalized.startsWith(`${extensionsDir}/`) && !activePaths.has(normalized)) {
      errors.push(`workspace extension is not registered in package pi.extensions: ${normalized}`);
    }
  }

  for (const ext of extensions) {
    if (!workspacePaths.has(ext.packagePath)) {
      errors.push(`${ext.name}: package extension is missing from workspaces`);
    }
  }
}

function requireActiveSidecarTargets(config, activeNames, errors) {
  for (const sidecarName of Object.keys(config.sidecars ?? {})) {
    if (!activeNames.has(sidecarName)) {
      errors.push(`sidecar config references inactive extension: ${sidecarName}`);
    }
  }
}

function rejectStaleIgnoredArtifacts(extensionsDir, activeNames, errors, root) {
  for (const dir of listExtensionDirs(extensionsDir, root)) {
    if (dir.name.startsWith("_") || activeNames.has(dir.name)) continue;
    const entries = readdirSync(dir.absPath);
    if (entries.includes("dist") && !entries.includes("index.ts")) {
      errors.push(`stale ignored extension artifact directory: ${relativeFromRepo(dir.absPath, root)} (run \`nub run clean:extensions\`)`);
    }
  }
}

export function validateExtensionInstall(manifest = loadExtensionManifest()) {
  const { repoRoot, pkg, config, extensionsDir, extensions } = manifest;
  const errors = [];
  const active = activeExtensionSets(extensions);

  requireUniqueActiveExtensions(extensions, errors);
  rejectDefaultDisabledActiveExtensions(extensions, errors);
  for (const ext of extensions) requireBuiltExtension(ext, config, errors, repoRoot);
  requireRegisteredPackageFiles(pkg, errors, repoRoot);
  requireWorkspaceParity(pkg, extensionsDir, active.packagePaths, extensions, errors);
  requireActiveSidecarTargets(config, active.names, errors);
  rejectStaleIgnoredArtifacts(extensionsDir, active.names, errors, repoRoot);

  return errors;
}
