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
    "usage: apply-managed-settings.mjs <settings-file> <managed-settings-file> <repo-path>",
  );
  process.exit(2);
}

function parseJsonRelaxed(file) {
  if (!fs.existsSync(file)) return {};
  return parseJsonRelaxedText(fs.readFileSync(file, "utf8"));
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

const before = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, "utf8") : "";
const settings = parseJsonRelaxed(settingsFile);
const managed = parseJsonRelaxed(managedSettingsFile);
const afterManagedSettings = renderSettings(applyManagedSettingsTransforms(settings, managed));

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
if (before !== afterManagedSettings) fs.writeFileSync(settingsFile, afterManagedSettings);

const agentDir = path.dirname(settingsFile);
const settingsManager = SettingsManager.create(repoPath, agentDir, { projectTrusted: false });
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
        new Error(`${scope} settings${settingsPath ? ` at ${settingsPath}` : ""}: ${error.message}`, {
          cause: error,
        }),
    ),
    "Pi package registration failed",
  );
}

let finalSettings = fs.readFileSync(settingsFile, "utf8");
if (!finalSettings.endsWith("\n")) {
  finalSettings += "\n";
  fs.writeFileSync(settingsFile, finalSettings);
}
console.log(before === finalSettings ? "unchanged" : before ? "updated" : "created");
