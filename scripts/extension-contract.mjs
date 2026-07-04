import { existsSync, readdirSync } from "node:fs";
import {
  ExtensionRuntime,
  extensionPaths,
  listExtensionDirs,
  loadExtensionManifest,
  normalizePackagePath,
  relativeFromRepo,
} from "./extension-manifest.mjs";

function requireUniqueActiveExtensions(manifest, errors) {
  const seenNames = new Set();
  const seenPaths = new Set();
  for (const ext of manifest.extensions) {
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

function rejectDefaultDisabledActiveExtensions(manifest, errors) {
  for (const ext of manifest.extensions) {
    if (ext.defaultDisabled) {
      errors.push(`${ext.name}: extension must stay disabled by default; do not register it in package pi.extensions`);
    }
  }
}

function requireBuiltExtension(ext, errors, root) {
  if (ext.hasPackageJson) {
    if (!Array.isArray(ext.runtimeEntries) || !ext.runtimeEntries.includes(ExtensionRuntime.PackageRuntimeEntry)) {
      errors.push(`${ext.name}: package.json pi.extensions must include ${ExtensionRuntime.PackageRuntimeEntry}`);
    }
  }
  if (!ext.hasSourceEntry) {
    errors.push(`${ext.name}: missing source entry ${relativeFromRepo(ext.sourceEntry, root)}`);
  }
  if (!ext.hasBundleEntry) {
    errors.push(`${ext.name}: missing built bundle ${relativeFromRepo(ext.bundleEntry, root)}`);
  }
  for (const sidecar of ext.sidecars) {
    if (!existsSync(sidecar.absOutfile)) {
      errors.push(`${ext.name}: missing built sidecar ${relativeFromRepo(sidecar.absOutfile, root)}`);
    }
  }
}

function requireRegisteredPackageFiles(manifest, errors) {
  for (const packagePath of manifest.packageExtensions) {
    const normalized = normalizePackagePath(packagePath);
    const paths = extensionPaths(manifest.repoRoot, normalized);
    if (!existsSync(paths.packageJson)) {
      errors.push(`package extension is missing package.json: ${normalized}`);
    }
  }
}

function requireWorkspaceParity(manifest, errors) {
  for (const normalized of manifest.workspacePaths) {
    if (normalized.startsWith(`${manifest.extensionsDir}/`) && !manifest.activePackagePaths.has(normalized)) {
      errors.push(`workspace extension is not registered in package pi.extensions: ${normalized}`);
    }
  }
  for (const ext of manifest.extensions) {
    if (!manifest.workspacePaths.has(ext.packagePath)) {
      errors.push(`${ext.name}: package extension is missing from workspaces`);
    }
  }
}

function requireActiveSidecarTargets(manifest, errors) {
  for (const sidecarName of Object.keys(manifest.config.sidecars ?? {})) {
    if (!manifest.activeNames.has(sidecarName)) {
      errors.push(`sidecar config references inactive extension: ${sidecarName}`);
    }
  }
}

function rejectStaleIgnoredArtifacts(manifest, errors) {
  for (const dir of listExtensionDirs(manifest.extensionsDir, manifest.repoRoot)) {
    if (dir.name.startsWith("_") || manifest.activeNames.has(dir.name)) continue;
    const entries = readdirSync(dir.absPath);
    if (entries.includes("dist") && !entries.includes(ExtensionRuntime.SourceEntry)) {
      errors.push(`stale ignored extension artifact directory: ${relativeFromRepo(dir.absPath, manifest.repoRoot)} (run \`nub run clean:extensions\`)`);
    }
  }
}

export function validateExtensionInstall(manifest = loadExtensionManifest()) {
  const errors = [];
  requireUniqueActiveExtensions(manifest, errors);
  rejectDefaultDisabledActiveExtensions(manifest, errors);
  for (const ext of manifest.extensions) requireBuiltExtension(ext, errors, manifest.repoRoot);
  requireRegisteredPackageFiles(manifest, errors);
  requireWorkspaceParity(manifest, errors);
  requireActiveSidecarTargets(manifest, errors);
  rejectStaleIgnoredArtifacts(manifest, errors);
  return errors;
}
