#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadDebianPolicy,
  parseDpkgQuery,
  planDebianSources,
  validateDebianPackages,
} from "./debian-compliance-core.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}\n${result.stderr?.trim() ?? ""}`.trim(),
    );
  }
  return result;
}

function safeName(value) {
  return value.replaceAll(/[^A-Za-z0-9._+-]/g, "_");
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function dscSha256Entries(content) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line === "Checksums-Sha256:");
  if (start < 0) throw new Error("Debian .dsc file has no Checksums-Sha256 field");
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(" ")) break;
    const match = line.trim().match(/^([0-9a-f]{64})\s+(\d+)\s+(\S+)$/);
    if (!match) throw new Error(`Invalid Checksums-Sha256 entry: ${line}`);
    entries.push({ sha256: match[1], size: Number(match[2]), file: match[3] });
  }
  if (entries.length === 0) throw new Error("Debian .dsc file has no source artifacts");
  return entries;
}

async function validateDownloadedSource(path) {
  const files = readdirSync(path).sort();
  const dscFiles = files.filter((file) => file.endsWith(".dsc"));
  if (dscFiles.length !== 1)
    throw new Error(`Expected one Debian .dsc file, found ${dscFiles.length}`);
  const entries = dscSha256Entries(readFileSync(join(path, dscFiles[0]), "utf8"));
  const expected = new Set([dscFiles[0], ...entries.map((entry) => entry.file)]);
  if (files.length !== expected.size || files.some((file) => !expected.has(file))) {
    throw new Error("Downloaded Debian source file set does not match its .dsc file");
  }
  for (const entry of entries) {
    const artifactPath = join(path, entry.file);
    const actual = await sha256(artifactPath);
    if (actual !== entry.sha256) throw new Error(`${entry.file}: .dsc SHA-256 does not match`);
  }
  return files;
}

export async function generateDebianSourceBundle({
  dpkgQueryPath,
  policyPath = join(defaultRepoRoot, "compliance", "debian-policy.json"),
  outputPath = join(defaultRepoRoot, "THIRD_PARTY_SOURCES", "debian"),
} = {}) {
  if (!dpkgQueryPath) throw new Error("A dpkg-query file is required");
  const packages = parseDpkgQuery(dpkgQueryPath);
  if (packages.length === 0)
    throw new Error(`No installed Debian packages found in ${dpkgQueryPath}`);
  const errors = validateDebianPackages(packages, loadDebianPolicy(policyPath));
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const workPath = mkdtempSync(join(tmpdir(), "pi-env-debian-sources-"));
  rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(join(outputPath, "artifacts"), { recursive: true });
  try {
    const debianSources = [];
    for (const source of planDebianSources(packages)) {
      console.log(`Collecting Debian source for ${source.name}@${source.version}`);
      const index = run("apt-cache", ["showsrc", source.name], { stdio: "pipe" }).stdout;
      const indexedVersions = [...index.matchAll(/^Version: (.+)$/gm)].map((match) => match[1]);
      if (!indexedVersions.includes(source.version)) {
        throw new Error(
          `${source.name}@${source.version}: exact source version is absent from apt source indexes`,
        );
      }
      const sourcePath = join(workPath, `${safeName(source.name)}-${safeName(source.version)}`);
      mkdirSync(sourcePath);
      run("apt-get", ["source", "--download-only", `${source.name}=${source.version}`], {
        cwd: sourcePath,
        stdio: "pipe",
      });
      const files = await validateDownloadedSource(sourcePath);
      const destination = join("artifacts", `${safeName(source.name)}-${safeName(source.version)}`);
      mkdirSync(join(outputPath, destination));
      const artifacts = [];
      for (const file of files) {
        const target = join(outputPath, destination, basename(file));
        copyFileSync(join(sourcePath, file), target);
        artifacts.push({ file: join(destination, basename(file)), sha256: await sha256(target) });
      }
      debianSources.push({ ...source, artifacts });
    }
    const manifest = { schemaVersion: 1, debianSources };
    writeFileSync(join(outputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(outputPath, "README.md"),
      [
        "# Debian corresponding source",
        "",
        "This directory accompanies the pi-env container image.",
        "It contains the complete exact source artifacts for every installed Debian source package.",
        "The manifest records a SHA-256 digest for every file downloaded through the configured apt source indexes.",
        "",
      ].join("\n"),
    );
    return manifest;
  } finally {
    rmSync(workPath, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    index += 1;
    if (index >= args.length) throw new Error(`Missing value for ${arg}`);
    if (arg === "--dpkg-query") options.dpkgQueryPath = resolve(args[index]);
    else if (arg === "--policy") options.policyPath = resolve(args[index]);
    else if (arg === "--output") options.outputPath = resolve(args[index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const manifest = await generateDebianSourceBundle(parseArgs(process.argv.slice(2)));
    console.log(
      `Generated source artifacts for ${manifest.debianSources.length} Debian source packages.`,
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
