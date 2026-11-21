import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scripts = [
  "settings-reset",
  "managed-settings",
  "agent-guidelines",
  "append-system",
  "setup-options",
  "node-policy",
  "repo-hooks",
  "worktree-init",
  "node-resolution",
  "pi-cli-wrapper",
  "home-manager-sync",
  "verify-install",
  "effect-runtime",
].map((name) => `setup/__tests__/${name}.test.sh`);
const callerState = [
  "PI_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "SETTINGS_FILE",
  "PI_PACKAGE_DIR",
  "PI_ENV_PI_EXECUTABLE",
  "PI_ENV_CLI_MANAGED_BY_NIX",
  "PI_ENV_HOME_MANAGER_FLAKE",
  "PI_ENV_HOME_MANAGER_INPUT",
];
const it = test.extend({
  fixture: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), "setup-report-"));
    const report = join(directory, "evidence", "setup.xml");
    const put = (path, content) => {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    };
    try {
      put("setup/node-runtime.sh", "pi_env_select_node_bin() { return 99; }\n");
      mkdirSync(join(directory, "scripts"));
      for (const path of ["setup/__tests__/run.sh", "scripts/setup-test-report.mjs"]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        copyFileSync(join(root, path), join(directory, path));
      }
      for (const path of scripts) put(path, "printf '%s\\n' \"$0\" >> order\n");
      const run = (reporting = true, reportPath = report) =>
        spawnSync("bash", ["setup/__tests__/run.sh"], {
          cwd: directory,
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            HOME: directory,
            PI_ENV_TEST_NODE_BIN: process.execPath,
            PI_ENV_TEST_REPORT: reporting ? reportPath : "",
            ...Object.fromEntries(callerState.map((name) => [name, "fixture-only"])),
          },
        });
      await use({ directory, report, put, run, xml: () => readFileSync(report, "utf8") });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

it("reports each completed script in suite order while isolating caller state", ({ fixture }) => {
  fixture.put(
    scripts[0],
    callerState.map((name) => `[ -z "\${${name}+set}" ] || exit 42`).join("\n") +
      `\nprintf '%s\\n' "$0" >> order\nprintf 'ordinary stdout\\n'\nprintf 'ordinary stderr\\n' >&2\n`,
  );
  const result = fixture.run();
  expect(result.status).toBe(0);
  expect(readFileSync(join(fixture.directory, "order"), "utf8").trim().split("\n")).toEqual(
    scripts,
  );
  expect(result.stdout).toContain("ordinary stdout");
  expect(result.stderr).toContain("ordinary stderr");
  expect(result.stdout).toContain(`setup-test: end ${scripts.at(-1)} status=0 elapsed=`);
  const xml = fixture.xml();
  expect(xml).toContain('tests="13" failures="0"');
  expect(
    [...xml.matchAll(/<testcase classname="setup" name="([^"]+)" time="([0-9.]+)"/g)].map(
      (match) => {
        expect(Number(match[2])).toBeGreaterThanOrEqual(0);
        return match[1];
      },
    ),
  ).toEqual(scripts);
  expect(xml).not.toMatch(/ordinary|system-out|system-err/);
});

it("retains partial evidence, bounded explicit failures, and the original fail-fast status", ({
  fixture,
}) => {
  fixture.put(
    scripts[1],
    `grep -q 'tests="1" failures="0"' "$PI_ENV_TEST_REPORT" || exit 43
printf 'private stdout sentinel\\n'
printf 'private stderr sentinel\\n' >&2
printf 'FAIL: expected <value> & "actual"\\001\\n' >&2
printf 'FAIL: ' >&2
printf '%05000d' 0 >&2
printf '\\nFAIL: later diagnostic\\n' >&2
exit 7
`,
  );
  const result = fixture.run();
  expect(result.status).toBe(7);
  expect(result.stdout).toContain("private stdout sentinel");
  expect(result.stderr).toContain("private stderr sentinel");
  expect(result.stdout).not.toContain(`setup-test: start ${scripts[2]}`);
  const xml = fixture.xml();
  expect(xml).toContain('tests="2" failures="1"');
  expect(xml).toContain(`${scripts[1]} exited with status 7; see the test:setup step log.`);
  expect(xml).toContain("FAIL: expected &lt;value&gt; &amp; &quot;actual&quot;");
  expect(xml).toContain("[FAIL diagnostics truncated]");
  expect(xml).not.toMatch(/private|later diagnostic|\u0001|system-out|system-err/);
  expect(xml.length).toBeLessThan(5200);
});

it("names unexpected failures without retaining arbitrary error output", ({ fixture }) => {
  fixture.put(scripts[0], "printf 'unexpected sensitive error\\n' >&2\nexit 19\n");
  const result = fixture.run();
  expect(result.status).toBe(19);
  expect(result.stderr).toContain("unexpected sensitive error");
  expect(fixture.xml()).toContain(
    `${scripts[0]} exited with status 19; see the test:setup step log.`,
  );
  expect(fixture.xml()).not.toContain("unexpected sensitive error");
});

it("does not let reporting errors hide a shell failure", ({ fixture }) => {
  fixture.put("not-a-directory", "fixture");
  fixture.put(scripts[0], "exit 23\n");
  const result = fixture.run(true, join(fixture.directory, "not-a-directory", "setup.xml"));
  expect(result.status).toBe(23);
  expect(result.stderr).toContain("could not write JUnit report");
  expect(result.stdout).not.toContain(`setup-test: start ${scripts[1]}`);
});

it("finishes successful tests but fails qualification when the report cannot be written", ({
  fixture,
}) => {
  fixture.put("not-a-directory", "fixture");
  const result = fixture.run(true, join(fixture.directory, "not-a-directory", "setup.xml"));
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(`setup-test: end ${scripts.at(-1)} status=0 elapsed=`);
});

it("keeps standalone execution independent of the reporter", ({ fixture }) => {
  fixture.put("scripts/setup-test-report.mjs", "throw new Error('must not run');\n");
  fixture.put(scripts[1], "printf 'standalone console\\n'\nexit 11\n");
  const result = fixture.run(false);
  expect(result.status).toBe(11);
  expect(result.stdout).toContain("standalone console");
  expect(result.stdout).not.toContain(`setup-test: start ${scripts[2]}`);
});
