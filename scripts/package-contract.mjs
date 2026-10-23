import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  const lockPath = join(root, "nub.lock");
  if (!existsSync(lockPath)) {
    errors.push(`package ${reason} is configured but nub.lock is missing`);
    return undefined;
  }
  return readFileSync(lockPath, "utf8");
}

function requireAllowScriptsContract(pkg, errors, root) {
  const allowScripts = pkg.allowScripts;
  if (allowScripts === undefined) return;
  if (!isRecord(allowScripts)) {
    errors.push(
      "package allowScripts must be an object of package names mapped to boolean install-script decisions",
    );
    return;
  }

  const lockText = readLockfile(root, errors, "allowScripts");
  if (lockText === undefined) return;
  for (const [packageName, approved] of Object.entries(allowScripts)) {
    if (typeof approved !== "boolean") {
      errors.push(`package allowScripts entry must be boolean: ${packageName}`);
    }
    if (!hasLockedPackage(lockText, packageName)) {
      errors.push(`package allowScripts package is not present in nub.lock: ${packageName}`);
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
      errors.push(`package patchedDependencies patch is not recorded in nub.lock: ${packageSpec}`);
    }
  }
}

export function validatePackageInstall(manifest) {
  const { repoRoot, pkg } = manifest;
  const errors = [];
  requireAllowScriptsContract(pkg, errors, repoRoot);
  requirePatchedDependenciesContract(pkg, errors, repoRoot);
  errors.push(
    ...validatePiRuntimeInstall(
      join(repoRoot, "node_modules/@earendil-works/pi-coding-agent"),
      pkg,
    ),
  );
  return errors;
}

export function validatePiRuntimeInstall(packageDir, pkg) {
  if (
    !Array.isArray(pkg.pi?.extensions) ||
    !pkg.pi.extensions.some(
      (path) => typeof path === "string" && path.replace(/^\.\//, "") === ".pi/extensions/share",
    )
  )
    return [];
  const checks = [
    ["core/extensions/loader.js", ["supportsBuiltinCommandOverrides"]],
    ["core/extensions/runner.js", ["getBuiltinCommandOverride"]],
    ["core/agent-session.js", ["tryExecuteBuiltinCommandOverride"]],
    ["modes/interactive/interactive-mode.js", [".tryExecuteBuiltinCommandOverride("]],
    ["core/extensions/types.d.ts", ["overrideBuiltin", "supportsBuiltinCommandOverrides"]],
  ];
  const sdk = checks.every(([path, markers]) => {
    const file = join(packageDir, "dist", path);
    if (!existsSync(file)) return false;
    const content = readFileSync(file, "utf8");
    return markers.every((marker) => content.includes(marker));
  });
  const required = new Set([
    "supportsBuiltinCommandOverrides",
    ".tryExecuteBuiltinCommandOverride(",
    "overrideBuiltin",
  ]);
  const chunks = join(packageDir, "dist/bundle/chunks");
  if (sdk && existsSync(chunks)) {
    for (const entry of readdirSync(chunks, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const content = readFileSync(join(chunks, entry.name), "utf8");
      for (const marker of required) if (content.includes(marker)) required.delete(marker);
      if (required.size === 0) return [];
    }
  }
  return [
    `Pi runtime at ${packageDir} lacks explicit built-in command override support. Reinstall dependencies or update the external Pi provisioner.`,
  ];
}
