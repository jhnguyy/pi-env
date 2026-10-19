import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../", import.meta.url));
const evidence = fs.mkdtempSync(
  path.join(process.env.PI_ENV_SETUP_EVIDENCE_DIR || os.tmpdir(), "pi-env-themes-"),
);
console.log(`Theme workflow evidence: ${evidence}`);
const repo = path.join(evidence, "package");
const agentDir = path.join(evidence, "agent");
const cwd = path.join(evidence, "project");
const settingsFile = path.join(agentDir, "settings.json");
const result = {
  inputs: { package: root, agentDir },
  expected:
    "setup registers both valid Gruvbox themes; fresh/reset settings select the pair; reruns preserve personal choices",
  actual: [],
  verdict: "fail",
  reproduce: "bash setup/__tests__/themes.test.sh",
};
try {
  for (const dir of [repo, agentDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(repo, "package.json"));
  if (fs.existsSync(path.join(root, "themes")))
    fs.cpSync(path.join(root, "themes"), path.join(repo, "themes"), { recursive: true });
  const configure = (reset = false) => {
    const run = spawnSync(
      process.execPath,
      [
        path.join(root, "setup/apply-managed-settings.mjs"),
        settingsFile,
        repo,
        ...(reset ? ["--reset"] : []),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: evidence,
          PI_CODING_AGENT_DIR: agentDir,
          PI_AGENT_DIR: agentDir,
        },
      },
    );
    fs.appendFileSync(
      path.join(evidence, "workflow.log"),
      `${run.stdout || ""}${run.stderr || ""}`,
    );
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  };
  const fresh = configure();
  assert.equal(fresh.theme, "gruvbox-light/gruvbox-dark");
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { themes, diagnostics } = loader.getThemes();
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(themes.map((theme) => theme.name).sort(), ["gruvbox-dark", "gruvbox-light"]);
  for (const appearance of ["light", "dark"]) {
    const theme = themes.find((theme) => theme.name === `gruvbox-${appearance}`);
    assert.equal(theme.appearance, appearance);
    assert.ok(theme.fg("text", "body text").includes("body text"));
    assert.ok(theme.bg("userMessageBg", "message").includes("message"));
    result.actual.push({ name: theme.name, appearance: theme.appearance, loaded: true });
  }
  for (const choice of ["system", "personal-theme", "gruvbox-light/gruvbox-dark"]) {
    fs.writeFileSync(settingsFile, JSON.stringify({ ...fresh, theme: choice }));
    assert.equal(configure().theme, choice);
  }
  assert.equal(configure(true).theme, fresh.theme);
  result.verdict = "pass";
} catch (error) {
  result.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  fs.writeFileSync(path.join(evidence, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
}
