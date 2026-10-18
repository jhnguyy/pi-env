import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../../", import.meta.url));
const startMarker = "<!-- pi-env:append-system:start -->";
const endMarker = "<!-- pi-env:append-system:end -->";

function createFixture() {
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), "pi-env-append-system-")));
  const home = join(evidence, "home");
  const agentDir = join(home, ".pi/agent");
  const source = readFileSync(join(root, ".pi/agent/APPEND_SYSTEM.md"), "utf8").trim();
  writeFileSync(
    join(evidence, "README.txt"),
    "Reproduce: bash setup/__tests__/append-system.test.sh\n" +
      "Inspect result.json, setup.log, and the before/after Markdown snapshots.\n",
  );
  console.log(`Append-system evidence: ${evidence}`);
  return {
    evidence,
    home,
    agentDir,
    appendFile: join(agentDir, "APPEND_SYSTEM.md"),
    source,
    expectedBlock: `${startMarker}\n${source}\n${endMarker}`,
  };
}

function configurePi(fixture) {
  const { home, agentDir, appendFile, evidence } = fixture;
  const result = spawnSync(process.execPath, ["setup/configure.mjs", "pi", process.execPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      REPO: root,
      SETUP_DIR: join(root, "setup"),
      SETTINGS_FILE: join(agentDir, "settings.json"),
      AGENTS_DIR: join(home, ".agents"),
      TEST_UTILS_DIR: join(agentDir, "extensions/__tests__"),
      APPEND_SRC: join(root, ".pi/agent/APPEND_SYSTEM.md"),
      APPEND_DST: appendFile,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      TMUX_CONF: join(home, ".tmux.conf"),
      TMUX_SOURCE_LINE: `source-file ${join(root, "setup/templates/tmux.conf")}`,
      GHOSTTY_CONFIG_DIR: join(home, ".config/ghostty"),
      POST_MERGE_HOOK_SRC: join(root, "setup/hooks/post-merge"),
      PRE_COMMIT_HOOK_SRC: join(root, "setup/hooks/pre-commit"),
    },
  });
  appendFileSync(join(evidence, "setup.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Pi configuration failed: ${result.stderr}`);
  return readFileSync(appendFile, "utf8");
}

function verifyFreshInstallation(fixture) {
  const actual = configurePi(fixture);
  writeFileSync(join(fixture.evidence, "fresh.md"), actual);
  assert.ok(actual.includes(fixture.expectedBlock), "fresh setup must install the source block");
  assert.equal(actual.split(startMarker).length - 1, 1, "start marker must occur once");
  assert.equal(actual.split(endMarker).length - 1, 1, "end marker must occur once");
}

function verifyLegacyUpgrade(fixture) {
  const legacy =
    "<!-- pi-env:append-system -->\n<!-- pi-env:append-system -->\n" +
    "Keep this personal rule.\n\n  Keep this spacing.  \n";
  writeFileSync(fixture.appendFile, legacy);
  writeFileSync(join(fixture.evidence, "legacy.md"), legacy);
  const actual = configurePi(fixture);
  writeFileSync(join(fixture.evidence, "upgraded.md"), actual);
  assert.equal(actual.slice(0, legacy.length), legacy, "legacy text must remain unchanged");
  assert.ok(actual.includes(fixture.expectedBlock), "legacy setup must install the source block");
  return actual;
}

async function verifyInstalledGuidanceLoads(fixture, installed) {
  const cwd = join(fixture.evidence, "project");
  mkdirSync(cwd);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: fixture.agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const loaded = loader.getAppendSystemPrompt();
  writeFileSync(join(fixture.evidence, "loaded.json"), JSON.stringify(loaded, null, 2));
  assert.ok(loaded.includes(installed), "Pi must load the installed guidance");
}

function verifyStaleBlockRepair(fixture, installed) {
  const expected = installed + "\n  Keep this trailing rule.  \n\n";
  const stale = expected.replace(fixture.source, "stale philosophy");
  writeFileSync(join(fixture.evidence, "expected-reconciled.md"), expected);
  writeFileSync(join(fixture.evidence, "stale.md"), stale);
  writeFileSync(fixture.appendFile, stale);
  const actual = configurePi(fixture);
  writeFileSync(join(fixture.evidence, "reconciled.md"), actual);
  assert.equal(actual, expected, "repair must change only the managed block");
  return actual;
}

function verifyRepeatedSetup(fixture, previous) {
  const actual = configurePi(fixture);
  writeFileSync(join(fixture.evidence, "repeated.md"), actual);
  assert.equal(actual, previous, "repeated setup must leave the entire file unchanged");
}

const fixture = createFixture();
try {
  verifyFreshInstallation(fixture);
  const installed = verifyLegacyUpgrade(fixture);
  await verifyInstalledGuidanceLoads(fixture, installed);
  const reconciled = verifyStaleBlockRepair(fixture, installed);
  verifyRepeatedSetup(fixture, reconciled);
  writeFileSync(
    join(fixture.evidence, "result.json"),
    JSON.stringify(
      {
        verdict: "pass",
        checks: ["fresh", "legacy", "startup-loader", "stale", "idempotent", "personal-preserved"],
      },
      null,
      2,
    ),
  );
  console.log("append-system workflow passed");
} catch (error) {
  writeFileSync(
    join(fixture.evidence, "result.json"),
    JSON.stringify(
      {
        verdict: "fail",
        error: String(error),
      },
      null,
      2,
    ),
  );
  throw error;
}
