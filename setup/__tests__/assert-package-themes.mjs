import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const { REPO: repo, PI_AGENT_DIR: agentDir, SETTINGS_FILE: settingsFile } = process.env;
const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
const loader = new DefaultResourceLoader({
  cwd: agentDir,
  agentDir,
  // Setup registers the primary checkout. Validate this worktree's package assets instead.
  settingsManager: SettingsManager.inMemory({ ...settings, packages: [repo] }),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noContextFiles: true,
});
await loader.reload();
const { themes, diagnostics } = loader.getThemes();
assert.deepEqual(diagnostics, []);
assert.deepEqual(themes.map((theme) => [theme.name, theme.appearance]).sort(), [
  ["gruvbox-dark", "dark"],
  ["gruvbox-light", "light"],
]);
console.log("Package themes loaded without diagnostics: gruvbox-light, gruvbox-dark");
