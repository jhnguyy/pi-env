import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const startMarker = "<!-- pi-env:append-system:start -->";
const endMarker = "<!-- pi-env:append-system:end -->";

function createFixture(home) {
  const agentDir = join(home, ".pi/agent");
  const source = readFileSync(join(root, "setup/templates/APPEND_SYSTEM.md"), "utf8").trim();
  mkdirSync(agentDir, { recursive: true });
  return {
    home,
    agentDir,
    appendFile: join(agentDir, "APPEND_SYSTEM.md"),
    source,
    expectedBlock: `${startMarker}\n${source}\n${endMarker}`,
  };
}

function configurePi({ home, agentDir, appendFile }) {
  const result = spawnSync(process.execPath, ["setup/configure.mjs", "pi", process.execPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      REPO: root,
      PI_AGENT_DIR: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
      XDG_CONFIG_HOME: join(home, ".config"),
      GHOSTTY_CONFIG_DIR: join(home, ".config/ghostty"),
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Pi configuration failed: ${result.stdout}${result.stderr}`);
  const report = result.stdout.split("\n").filter((line) => line.includes("APPEND_SYSTEM.md"));
  assert.equal(
    report.length,
    1,
    `one status line must cover all APPEND_SYSTEM.md blocks: ${report}`,
  );
  return { text: readFileSync(appendFile, "utf8"), report: report[0] };
}

function verifyPersonalTextPreserved(fixture) {
  const personal = "Keep this personal rule.\n\n  Keep this spacing.  \n";
  writeFileSync(fixture.appendFile, personal);
  const { text: actual } = configurePi(fixture);
  assert.equal(actual.slice(0, personal.length), personal, "personal text must remain unchanged");
  assert.ok(actual.includes(fixture.expectedBlock), "setup must install the source block");
  return actual;
}

function verifyStaleBlockRepair(fixture, installed) {
  const expected = installed + "\n  Keep this trailing rule.  \n\n";
  writeFileSync(fixture.appendFile, expected.replace(fixture.source, "stale philosophy"));
  const { text: actual, report } = configurePi(fixture);
  assert.equal(actual, expected, "repair must change only the managed block");
  assert.match(
    report,
    /\(updated: append-system\)$/,
    "the report must name only the repaired block",
  );
  const rerun = configurePi(fixture);
  assert.equal(rerun.text, expected, "a rerun must not change APPEND_SYSTEM.md");
  assert.match(rerun.report, /\(managed blocks current\)$/);
}

using home = mkdtempDisposableSync(join(tmpdir(), "pi-env-append-system-"));
const fixture = createFixture(home.path);
verifyStaleBlockRepair(fixture, verifyPersonalTextPreserved(fixture));
console.log("append-system workflow passed");
