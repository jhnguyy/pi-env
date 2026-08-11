#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadAlpinePolicy,
  parseApkInstalled,
  planAlpineSources,
  validateAlpinePackages,
} from "./generate-license-bundle.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = dirname(dirname(scriptPath));
const defaultAportsRepository = "https://gitlab.alpinelinux.org/alpine/aports.git";
const defaultDistfilesMirror = "https://distfiles.alpinelinux.org/distfiles/v3.24";
const aportsSections = ["main", "community", "testing"];

function run(command, args, { cwd, quiet = false, allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: quiet ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = quiet ? `\n${result.stderr.trim()}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`);
  }
  return result;
}

function runWithRetries(command, args, options, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run(command, args, { ...options, allowFailure: true });
    if (result.status === 0) return;
    if (attempt < attempts) {
      console.error(`${command} failed. Retrying source fetch (${attempt + 1}/${attempts}).`);
    }
  }
  throw new Error(`${command} ${args.join(" ")} failed after ${attempts} attempts`);
}

function safeName(value) {
  return value.replaceAll(/[^A-Za-z0-9._+-]/g, "_");
}

function findRecipePath(repositoryPath, buildCommit, origin) {
  const matches = aportsSections
    .map((section) => `${section}/${origin}`)
    .filter(
      (path) =>
        run("git", ["-C", repositoryPath, "cat-file", "-e", `${buildCommit}:${path}/APKBUILD`], {
          quiet: true,
          allowFailure: true,
        }).status === 0,
    );
  if (matches.length !== 1) {
    throw new Error(
      `${origin}@${buildCommit}: expected one aports recipe, found ${matches.length}`,
    );
  }
  return matches[0];
}

function sourceArchive(outputPath) {
  const sourcePath = join(outputPath, "src");
  const archives = existsSync(sourcePath)
    ? readdirSync(sourcePath).filter((name) => name.endsWith(".src.tar.gz"))
    : [];
  if (archives.length !== 1) {
    throw new Error(
      `Expected one Alpine source package in ${sourcePath}, found ${archives.length}`,
    );
  }
  return join(sourcePath, archives[0]);
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export async function generateAlpineSourceBundle({
  apkDbPath = "/lib/apk/db/installed",
  policyPath = join(defaultRepoRoot, "compliance", "alpine-policy.json"),
  outputPath = join(defaultRepoRoot, "THIRD_PARTY_SOURCES", "alpine"),
  aportsRepository = defaultAportsRepository,
  distfilesMirror = defaultDistfilesMirror,
} = {}) {
  const packages = parseApkInstalled(apkDbPath);
  if (packages.length === 0) throw new Error(`No installed Alpine packages found in ${apkDbPath}`);
  const policy = loadAlpinePolicy(policyPath);
  const errors = validateAlpinePackages(packages, policy);
  if (errors.length > 0) throw new Error(errors.join("\n"));

  const sourcePlan = planAlpineSources(packages, policy);
  if (sourcePlan.length === 0) throw new Error("No source-required Alpine packages found");

  const workPath = mkdtempSync(join(tmpdir(), "pi-env-alpine-sources-"));
  const repositoryPath = join(workPath, "aports");
  const archivesPath = join(outputPath, "archives");
  rmSync(outputPath, { recursive: true, force: true });
  mkdirSync(archivesPath, { recursive: true });

  try {
    run("git", ["init", "--quiet", repositoryPath]);
    run("git", ["-C", repositoryPath, "remote", "add", "origin", aportsRepository]);

    const sources = [];
    for (const group of sourcePlan) {
      if (!/^[0-9a-f]{40}$/i.test(group.buildCommit)) {
        throw new Error(`${group.origin}: exact Alpine build commit is missing`);
      }
      console.log(`Collecting Alpine source for ${group.origin}@${group.buildCommit}`);
      run("git", [
        "-C",
        repositoryPath,
        "-c",
        "protocol.version=2",
        "fetch",
        "--quiet",
        "--depth=1",
        "--filter=blob:none",
        "origin",
        group.buildCommit,
      ]);

      const recipePath = findRecipePath(repositoryPath, group.buildCommit, group.origin);
      const unitName = `${safeName(group.origin)}-${group.buildCommit}`;
      const unitPath = join(workPath, unitName);
      const recipeArchive = join(workPath, `${unitName}.tar`);
      mkdirSync(unitPath, { recursive: true });
      run("git", [
        "-C",
        repositoryPath,
        "archive",
        "--format=tar",
        "--output",
        recipeArchive,
        group.buildCommit,
        recipePath,
      ]);
      run("tar", ["-xf", recipeArchive, "-C", unitPath]);

      const sourceDestination = join(workPath, `${unitName}-distfiles`);
      const sourcePackageOutput = join(workPath, `${unitName}-output`);
      mkdirSync(sourceDestination, { recursive: true });
      mkdirSync(sourcePackageOutput, { recursive: true });
      runWithRetries(
        "abuild",
        [
          "-F",
          "-d",
          "-C",
          join(unitPath, recipePath),
          "-P",
          sourcePackageOutput,
          "-s",
          sourceDestination,
          "srcpkg",
        ],
        { env: { DISTFILES_MIRROR: distfilesMirror } },
      );

      const generatedArchive = sourceArchive(sourcePackageOutput);
      const archiveName = `${unitName}.src.tar.gz`;
      const archivePath = join(archivesPath, archiveName);
      copyFileSync(generatedArchive, archivePath);
      sources.push({
        origin: group.origin,
        buildCommit: group.buildCommit,
        recipePath,
        archive: `archives/${archiveName}`,
        sha256: await hashFile(archivePath),
        packages: group.packages,
      });
    }

    const manifest = {
      schemaVersion: 1,
      aportsRepository,
      sources,
    };
    writeFileSync(join(outputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(outputPath, "README.md"),
      [
        "# Alpine corresponding source",
        "",
        "This directory accompanies the pi-env container image.",
        "It contains complete source packages for Alpine components whose licenses require source availability.",
        "",
        "Each archive was generated with `abuild srcpkg` from the exact aports build commit in `manifest.json`.",
        "The archive contains the APKBUILD, local patches, install scripts, and checksum-verified upstream source files.",
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
    const value = () => {
      index += 1;
      if (index >= args.length) throw new Error(`Missing value for ${arg}`);
      return args[index];
    };
    if (arg === "--apk-db") options.apkDbPath = resolve(value());
    else if (arg === "--policy") options.policyPath = resolve(value());
    else if (arg === "--output") options.outputPath = resolve(value());
    else if (arg === "--aports-repository") options.aportsRepository = value();
    else if (arg === "--distfiles-mirror") options.distfilesMirror = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = await generateAlpineSourceBundle(options);
    console.log(`Generated ${manifest.sources.length} Alpine corresponding-source archives.`);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
