#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { initialSettings, parseJsonRelaxedText, renderSettings } from "./managed-settings-core.mjs";

const [settingsFile, repoPath, mode] = process.argv.slice(2);
const reset = mode === "--reset";

if (!settingsFile || !repoPath || (mode && !reset)) {
  console.error(
    "🤖: usage: apply-managed-settings.mjs <agent-dir>/settings.json <repo-path> [--reset]",
  );
  process.exit(2);
}
if (path.basename(settingsFile) !== "settings.json") {
  throw new Error(`settings file must be named settings.json: ${settingsFile}`);
}

function parseJsonRelaxed(file) {
  if (!fs.existsSync(file)) return {};
  return parseJsonRelaxedText(fs.readFileSync(file, "utf8"));
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
const settings =
  reset || !settingsExisted
    ? initialSettings(parseJsonRelaxed(path.join(path.dirname(settingsFile), "auth.json")))
    : parseJsonRelaxed(settingsFile);
if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
  throw new Error("🤖: settings must be a JSON object");
}
if (settings.packages !== undefined) {
  if (!Array.isArray(settings.packages)) throw new Error("🤖: settings.packages must be an array");
  assertValidPackageSources(settings);
}

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
if (reset && settingsExisted) {
  const backup = `${settingsFile}.backup-${Date.now()}`;
  fs.writeFileSync(backup, before, { flag: "wx", mode: 0o600 });
  console.error(`🤖: Settings backup: ${backup}`);
}

const agentDir = path.dirname(settingsFile);
let settingsManager;
try {
  let needsNormalization = false;
  if (settingsExisted && !reset) {
    try {
      JSON.parse(before);
    } catch {
      needsNormalization = true;
    }
  }
  // Pi reads strict JSON. Preserve accepted legacy preferences before registration.
  if (reset || !settingsExisted || needsNormalization)
    fs.writeFileSync(settingsFile, renderSettings(settings));
  settingsManager = SettingsManager.create(repoPath, agentDir, { projectTrusted: false });
  const packageManager = new DefaultPackageManager({ cwd: repoPath, agentDir, settingsManager });
  const packagePath = packageRepoPath();
  await packageManager.installAndPersist(packagePath);
  if (packagePath !== repoPath) packageManager.removeSourceFromSettings(repoPath);
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
