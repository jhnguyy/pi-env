#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyManagedSettingsTransforms,
  parseJsonRelaxedText,
  renderSettings,
} from "./managed-settings-core.mjs";

const [settingsFile, managedSettingsFile, repoPath] = process.argv.slice(2);

if (!settingsFile || !managedSettingsFile || !repoPath) {
  console.error(
    "usage: apply-managed-settings.mjs <agent-dir>/settings.json <managed-settings-file> <repo-path>",
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
const settings = parseJsonRelaxed(settingsFile);
const managed = parseJsonRelaxed(managedSettingsFile);
const transformedSettings = applyManagedSettingsTransforms(settings, managed);
assertValidPackageSources(transformedSettings);
const afterManagedSettings = renderSettings(transformedSettings);

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
if (before !== afterManagedSettings) fs.writeFileSync(settingsFile, afterManagedSettings);

const agentDir = path.dirname(settingsFile);
const settingsManager = SettingsManager.create(repoPath, agentDir, { projectTrusted: false });
const packageManager = new DefaultPackageManager({ cwd: repoPath, agentDir, settingsManager });
const packagePath = packageRepoPath();
try {
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
  await settingsManager.flush();
  try {
    if (settingsExisted) fs.writeFileSync(settingsFile, before);
    else fs.rmSync(settingsFile, { force: true });
  } catch (restoreError) {
    const registrationMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Pi package registration failed and settings rollback also failed: ${registrationMessage}`, {
      cause: restoreError,
    });
  }
  throw error;
}

let finalSettings = fs.readFileSync(settingsFile, "utf8");
if (!finalSettings.endsWith("\n")) {
  finalSettings += "\n";
  fs.writeFileSync(settingsFile, finalSettings);
}
console.log(before === finalSettings ? "unchanged" : settingsExisted ? "updated" : "created");
