#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = [
  "THIRD_PARTY_LICENSES/manifest.json",
  "THIRD_PARTY_LICENSES/THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES/SOURCE_CODE.md",
  "THIRD_PARTY_LICENSES/DEBIAN_PACKAGES.md",
  "THIRD_PARTY_LICENSES/DEBIAN_SOURCE_CODE.md",
  "THIRD_PARTY_LICENSES/system/node-LICENSE.txt",
  "THIRD_PARTY_SOURCES/debian/manifest.json",
];

const REQUIRED_DIRECTORIES = [".pi/extensions/dev-tools/dist"];

function safeArchivePath(manifestPath, archive) {
  if (typeof archive !== "string" || archive === "" || isAbsolute(archive)) return null;
  const base = dirname(manifestPath);
  const archivePath = resolve(base, archive);
  const fromBase = relative(base, archivePath);
  if (fromBase === ".." || fromBase.startsWith("../")) return null;
  return archivePath;
}

function requiredOutputIssues(root) {
  const missingFiles = REQUIRED_FILES.filter((path) => {
    const absolutePath = join(root, path);
    return !existsSync(absolutePath) || !statSync(absolutePath).isFile();
  }).map((path) => `required image file is missing: ${path}`);
  const missingDirectories = REQUIRED_DIRECTORIES.filter((path) => {
    const absolutePath = join(root, path);
    return !existsSync(absolutePath) || !statSync(absolutePath).isDirectory();
  }).map((path) => `required image directory is missing: ${path}`);
  return [...missingFiles, ...missingDirectories];
}

function sourceArchiveIssues(root) {
  const manifestPath = join(root, "THIRD_PARTY_SOURCES", "debian", "manifest.json");
  if (!existsSync(manifestPath)) return [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    return [
      `Debian source manifest is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    ];
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.debianSources)) {
    return ["Debian source manifest has an unsupported schema"];
  }
  if (manifest.debianSources.length === 0) {
    return ["Debian source manifest contains no source artifacts"];
  }
  return manifest.debianSources.flatMap((source) =>
    Array.isArray(source.artifacts) && source.artifacts.length > 0
      ? source.artifacts.flatMap((artifact) => {
          const artifactPath = safeArchivePath(manifestPath, artifact.file);
          const valid =
            artifactPath &&
            existsSync(artifactPath) &&
            statSync(artifactPath).isFile() &&
            statSync(artifactPath).size > 0 &&
            createHash("sha256").update(readFileSync(artifactPath)).digest("hex") ===
              artifact.sha256;
          return valid
            ? []
            : [`${source.name ?? "unknown source"}: source artifact is missing, empty, or invalid`];
        })
      : [`${source.name ?? "unknown source"}: source artifacts are missing`],
  );
}

export function imageArtifactIssues(root) {
  return [...requiredOutputIssues(root), ...sourceArchiveIssues(root)];
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

export function verifyImageArtifact(root) {
  const issues = imageArtifactIssues(root);
  if (issues.length > 0) throw new Error(issues.join("\n"));

  run("node", ["--version"], "Node.js check");
  run("nub", ["--version"], "Nub check");
  run(
    "sh",
    [
      "-c",
      "dpkg-query -W -f='${binary:Package}\\t${Version}\\t${source:Package}\\t${source:Version}\\n' > /tmp/pi-env-dpkg-query",
    ],
    "Debian package inventory",
  );
  run(
    process.execPath,
    [
      join(root, "scripts", "generate-license-bundle.mjs"),
      "--check",
      "--package-root",
      "/usr/local/lib/node_modules",
      "--dpkg-query",
      "/tmp/pi-env-dpkg-query",
      "--debian-source-manifest",
      join(root, "THIRD_PARTY_SOURCES", "debian", "manifest.json"),
      "--system-license",
      "node-LICENSE.txt=/usr/local/LICENSE",
    ],
    "Image license compliance check",
  );
  run("nub", ["run", "verify:install"], "Image install readiness check");
}

function parseArgs(args) {
  let root = process.env.PI_ENV_HOME ?? "/opt/pi-env";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--root") throw new Error(`Unknown argument: ${arg}`);
    index += 1;
    if (index >= args.length) throw new Error("Missing value for --root");
    root = args[index];
  }
  return { root: resolve(root) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { root } = parseArgs(process.argv.slice(2));
    verifyImageArtifact(root);
    console.log("Image artifact contract passed.");
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
