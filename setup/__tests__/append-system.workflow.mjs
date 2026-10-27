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

const root = fileURLToPath(new URL("../../", import.meta.url));
const startMarker = "<!-- pi-env:append-system:start -->";
const endMarker = "<!-- pi-env:append-system:end -->";

function createFixture() {
  const evidence = realpathSync(mkdtempSync(join(tmpdir(), "pi-env-append-system-")));
  const home = join(evidence, "home");
  const agentDir = join(home, ".pi/agent");
  const source = readFileSync(join(root, ".pi/agent/APPEND_SYSTEM.md"), "utf8").trim();
  mkdirSync(agentDir, { recursive: true });
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
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      AGENTS_DIR: join(home, ".agents"),
      XDG_CONFIG_HOME: join(home, ".config"),
      GHOSTTY_CONFIG_DIR: join(home, ".config/ghostty"),
    },
  });
  appendFileSync(join(evidence, "setup.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Pi configuration failed: ${result.stderr}`);
  const report = result.stdout.split("\n").filter((line) => line.includes("APPEND_SYSTEM.md"));
  assert.equal(report.length, 1, `one status line must cover all APPEND_SYSTEM.md blocks: ${report}`);
  return { text: readFileSync(appendFile, "utf8"), report: report[0] };
}

function verifyLegacyUpgrade(fixture) {
  const legacy =
    "<!-- pi-env:append-system -->\n<!-- pi-env:append-system -->\n" +
    "Keep this personal rule.\n\n  Keep this spacing.  \n";
  writeFileSync(fixture.appendFile, legacy);
  writeFileSync(join(fixture.evidence, "legacy.md"), legacy);
  const { text: actual } = configurePi(fixture);
  writeFileSync(join(fixture.evidence, "upgraded.md"), actual);
  assert.equal(actual.slice(0, legacy.length), legacy, "legacy text must remain unchanged");
  assert.ok(actual.includes(fixture.expectedBlock), "legacy setup must install the source block");
  return actual;
}

function verifyStaleBlockRepair(fixture, installed) {
  const expected = installed + "\n  Keep this trailing rule.  \n\n";
  const stale = expected.replace(fixture.source, "stale philosophy");
  writeFileSync(join(fixture.evidence, "expected-reconciled.md"), expected);
  writeFileSync(join(fixture.evidence, "stale.md"), stale);
  writeFileSync(fixture.appendFile, stale);
  const { text: actual, report } = configurePi(fixture);
  writeFileSync(join(fixture.evidence, "reconciled.md"), actual);
  assert.equal(actual, expected, "repair must change only the managed block");
  assert.match(report, /\(updated: append-system\)$/, "the report must name only the repaired block");
  const rerun = configurePi(fixture);
  assert.equal(rerun.text, expected, "a rerun must not change APPEND_SYSTEM.md");
  assert.match(rerun.report, /\(managed blocks current\)$/);
}

const fixture = createFixture();
try {
  const installed = verifyLegacyUpgrade(fixture);
  verifyStaleBlockRepair(fixture, installed);
  writeFileSync(
    join(fixture.evidence, "result.json"),
    JSON.stringify(
      {
        verdict: "pass",
        checks: ["legacy-upgrade", "stale-repair", "exact-preservation", "single-report", "rerun"],
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
