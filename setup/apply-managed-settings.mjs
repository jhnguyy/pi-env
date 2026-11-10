#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyManagedSettings, initialSettings, renderSettings } from "./managed-settings-core.mjs";

const [settingsFile, repoPath, mode] = process.argv.slice(2);
const reset = mode === "--reset";

if (!settingsFile || !repoPath || (mode && !reset)) {
  console.error(
    "usage: apply-managed-settings.mjs <agent-dir>/settings.json <repo-path> [--reset]",
  );
  process.exit(2);
}
if (path.basename(settingsFile) !== "settings.json") {
  throw new Error(`settings file must be named settings.json: ${settingsFile}`);
}

// Match Pi's settings reader: empty means no settings, and a leading BOM is ignored.
function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return text.trim() === "" ? {} : JSON.parse(text);
}

function assertValidPackageSources(settings) {
  const invalidIndex = settings.packages.findIndex(
    (source) =>
      typeof source !== "string" &&
      !(source !== null && typeof source === "object" && typeof source.source === "string"),
  );
  if (invalidIndex !== -1) {
    throw new Error(
      `settings.packages[${invalidIndex}] must be a string or an object with a string source`,
    );
  }
}

// Package filters name resource paths inside the package. pi-env moved its resources out of
// .pi/ and .agents/, so saved selections must follow them to keep the same meaning.
const RelocatedPrefixes = [
  [".pi/extensions/", "extensions/"],
  [".agents/skills/", "skills/"],
];

function relocateFilter(pattern) {
  if (typeof pattern !== "string") return pattern;
  // Pi accepts an optional ./ before package-relative paths; keep the original spelling.
  const [, operator, dot, target] = /^([+\-!]?)(\.\/)?(.*)$/s.exec(pattern);
  const match = RelocatedPrefixes.find(([from]) => target.startsWith(from));
  return match ? `${operator}${dot ?? ""}${match[1]}${target.slice(match[0].length)}` : pattern;
}

// Pi expands a leading ~ in package sources; other relative sources resolve from settings.
function resolveSource(source) {
  if (source === "~") return os.homedir();
  if (source.startsWith("~/")) return path.join(os.homedir(), source.slice(2));
  return path.resolve(path.dirname(settingsFile), source);
}

function relocatePiEnvFilters(entry, piEnvSources) {
  if (typeof entry !== "object") return entry;
  if (!piEnvSources.has(resolveSource(entry.source))) return entry;
  const relocated = { ...entry };
  for (const key of ["extensions", "skills"]) {
    if (Array.isArray(entry[key])) relocated[key] = entry[key].map(relocateFilter);
  }
  return relocated;
}

function gitOutput(args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function packageRepoPath() {
  const gitDir = gitOutput(["rev-parse", "--absolute-git-dir"]);
  const commonDir = gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!gitDir || !commonDir || gitDir === commonDir) return repoPath;

  // Worktrees share the primary checkout's common .git directory. Register the
  // primary checkout as the pi package so temporary feature worktrees do not
  // create duplicate skills/themes/extensions in every new pi session.
  return path.dirname(commonDir);
}

const settingsExisted = fs.existsSync(settingsFile);
const before = settingsExisted ? fs.readFileSync(settingsFile, "utf8") : "";
const baseSettings =
  reset || !settingsExisted
    ? initialSettings(readJson(path.join(path.dirname(settingsFile), "auth.json")))
    : readJson(settingsFile);
if (baseSettings === null || typeof baseSettings !== "object" || Array.isArray(baseSettings)) {
  throw new Error("settings must be a JSON object");
}
const settings = applyManagedSettings(baseSettings);
const packagePath = packageRepoPath();
if (settings.packages !== undefined) {
  if (!Array.isArray(settings.packages)) throw new Error("settings.packages must be an array");
  assertValidPackageSources(settings);
  const piEnvSources = new Set([path.resolve(repoPath), path.resolve(packagePath)]);
  settings.packages = settings.packages.map((entry) => relocatePiEnvFilters(entry, piEnvSources));
  if (packagePath !== repoPath) {
    const sourceOf = (entry) => resolveSource(typeof entry === "string" ? entry : entry.source);
    const hasPrimary = settings.packages.some((entry) => sourceOf(entry) === packagePath);
    // Keep an existing primary selection intact; combining filters could enable
    // resources the user excluded. Otherwise move the whole worktree entry.
    settings.packages = settings.packages.flatMap((entry) => {
      if (sourceOf(entry) !== path.resolve(repoPath)) return [entry];
      if (hasPrimary) return [];
      return [typeof entry === "string" ? packagePath : { ...entry, source: packagePath }];
    });
  }
}

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
if (reset && settingsExisted) {
  const backup = `${settingsFile}.backup-${Date.now()}`;
  fs.writeFileSync(backup, before, { flag: "wx", mode: 0o600 });
  console.error(`Settings backup: ${backup}`);
}

const agentDir = path.dirname(settingsFile);
let settingsManager;
try {
  if (reset || !settingsExisted || !isDeepStrictEqual(settings, baseSettings))
    fs.writeFileSync(settingsFile, renderSettings(settings));
  settingsManager = SettingsManager.create(repoPath, agentDir, { projectTrusted: false });
  const packageManager = new DefaultPackageManager({ cwd: repoPath, agentDir, settingsManager });
  await packageManager.installAndPersist(packagePath);
  await settingsManager.flush();
  const settingsErrors = settingsManager.drainErrors();
  if (settingsErrors.length > 0) {
    throw new AggregateError(
      settingsErrors.map(
        ({ scope, path: settingsPath, error }) =>
          new Error(
            `${scope} settings${settingsPath ? ` at ${settingsPath}` : ""}: ${error.message}`,
            { cause: error },
          ),
      ),
      "Pi package registration failed",
    );
  }
} catch (error) {
  try {
    await settingsManager?.flush();
  } finally {
    try {
      if (settingsExisted) fs.writeFileSync(settingsFile, before);
      else fs.rmSync(settingsFile, { force: true });
    } catch (restoreError) {
      const registrationMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Pi package registration failed and settings rollback also failed: ${registrationMessage}`,
        {
          cause: restoreError,
        },
      );
    }
  }
  throw error;
}

let finalSettings = fs.readFileSync(settingsFile, "utf8");
if (!finalSettings.endsWith("\n")) {
  finalSettings += "\n";
  fs.writeFileSync(settingsFile, finalSettings);
}
console.log(before === finalSettings ? "unchanged" : settingsExisted ? "updated" : "created");
