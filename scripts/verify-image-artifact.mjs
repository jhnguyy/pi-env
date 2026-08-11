#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = [
  "THIRD_PARTY_LICENSES/manifest.json",
  "THIRD_PARTY_LICENSES/THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES/SOURCE_CODE.md",
  "THIRD_PARTY_LICENSES/ALPINE_PACKAGES.md",
  "THIRD_PARTY_LICENSES/ALPINE_SOURCE_CODE.md",
  "THIRD_PARTY_LICENSES/system/node-LICENSE.txt",
  "THIRD_PARTY_SOURCES/alpine/manifest.json",
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
  const manifestPath = join(root, "THIRD_PARTY_SOURCES", "alpine", "manifest.json");
  if (!existsSync(manifestPath)) return [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    return [
      `Alpine source manifest is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    ];
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.sources)) {
    return ["Alpine source manifest has an unsupported schema"];
  }
  if (manifest.sources.length === 0) {
    return ["Alpine source manifest contains no source archives"];
  }
  return manifest.sources.flatMap((source) => {
    const archivePath = safeArchivePath(manifestPath, source.archive);
    const validArchive =
      archivePath &&
      existsSync(archivePath) &&
      statSync(archivePath).isFile() &&
      statSync(archivePath).size > 0;
    return validArchive
      ? []
      : [`${source.origin ?? "unknown origin"}: source archive is missing or empty`];
  });
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
    process.execPath,
    [
      join(root, "scripts", "generate-license-bundle.mjs"),
      "--check",
      "--package-root",
      "/usr/local/lib/node_modules",
      "--apk-db",
      "/lib/apk/db/installed",
      "--alpine-source-manifest",
      join(root, "THIRD_PARTY_SOURCES", "alpine", "manifest.json"),
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
