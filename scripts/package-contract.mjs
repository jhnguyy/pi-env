import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLockedPackage(lockText, packageName) {
  const escaped = escapeRegExp(packageName);
  const pattern = new RegExp(`(?:^|\\n)\\s{2}(?:'${escaped}@[^'\\n]+':|${escaped}@[^:\\n]+:)`);
  return pattern.test(lockText);
}

function readLockfile(root, errors, reason) {
  const lockPath = join(root, "lock.yaml");
  if (!existsSync(lockPath)) {
    errors.push(`package ${reason} is configured but lock.yaml is missing`);
    return undefined;
  }
  return readFileSync(lockPath, "utf8");
}

function requireAllowBuildsContract(pkg, errors, root) {
  const allowBuilds = pkg.allowBuilds;
  if (allowBuilds === undefined) return;
  if (!isRecord(allowBuilds)) {
    errors.push("package allowBuilds must be an object of package names mapped to boolean install-build decisions");
    return;
  }

  const lockText = readLockfile(root, errors, "allowBuilds");
  if (lockText === undefined) return;
  for (const [packageName, approved] of Object.entries(allowBuilds)) {
    if (typeof approved !== "boolean") {
      errors.push(`package allowBuilds entry must be boolean: ${packageName}`);
    }
    if (!hasLockedPackage(lockText, packageName)) {
      errors.push(`package allowBuilds package is not present in lock.yaml: ${packageName}`);
    }
  }
}

function requirePatchedDependenciesContract(pkg, errors, root) {
  const patchedDependencies = pkg.patchedDependencies;
  if (patchedDependencies === undefined) return;
  if (!isRecord(patchedDependencies)) {
    errors.push("package patchedDependencies must be an object of package specs to patch files");
    return;
  }

  const lockText = readLockfile(root, errors, "patchedDependencies");
  if (lockText === undefined) return;
  for (const [packageSpec, patchPath] of Object.entries(patchedDependencies)) {
    if (typeof patchPath !== "string" || patchPath.trim() === "") {
      errors.push(`package patchedDependencies entry must point to a patch file: ${packageSpec}`);
      continue;
    }
    if (!existsSync(join(root, patchPath))) {
      errors.push(`package patchedDependencies patch file is missing: ${patchPath}`);
    }
    if (!lockText.includes(`path: ${patchPath}`)) {
      errors.push(`package patchedDependencies patch is not recorded in lock.yaml: ${packageSpec}`);
    }
  }
}

export function validatePackageInstall(manifest) {
  const { repoRoot, pkg } = manifest;
  const errors = [];
  requireAllowBuildsContract(pkg, errors, repoRoot);
  requirePatchedDependenciesContract(pkg, errors, repoRoot);
  return errors;
}
