import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function normalizePackagePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function extensionNameFromPath(path) {
  return posix.basename(normalizePackagePath(path));
}

export function loadExtensionManifest(root = repoRoot) {
  const packagePath = join(root, "package.json");
  const configPath = join(root, "pi-build.config.json");
  const pkg = loadJson(packagePath);
  const config = loadJson(configPath);
  const extensionsDir = normalizePackagePath(config.extensionsDir ?? ".pi/extensions");
  const packageExtensions = pkg.pi?.extensions ?? [];
  const extensions = packageExtensions
    .filter((path) => normalizePackagePath(path).startsWith(`${extensionsDir}/`))
    .map((path) => {
      const packagePath = normalizePackagePath(path);
      const name = extensionNameFromPath(packagePath);
      return {
        name,
        packagePath,
        absPath: join(root, ...packagePath.split("/")),
      };
    });
  return { repoRoot: root, pkg, config, extensionsDir, extensions };
}

export function listExtensionDirs(extensionsDir, root = repoRoot) {
  const absDir = join(root, ...normalizePackagePath(extensionsDir).split("/"));
  if (!existsSync(absDir)) return [];
  return readdirSync(absDir)
    .map((name) => ({ name, absPath: join(absDir, name) }))
    .filter((entry) => statSync(entry.absPath).isDirectory());
}

export function relativeFromRepo(absPath, root = repoRoot) {
  return absPath.replace(`${root}${sep}`, "").replaceAll("\\", "/");
}
