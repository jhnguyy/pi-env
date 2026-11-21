import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("../ci-report.mjs", import.meta.url));
const it = test.extend({
  directory: async ({}, use) => {
    const directory = mkdtempSync(join(tmpdir(), "ci-report-"));
    try {
      await use(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
});

function run(directory, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: join(directory, "summary.md") },
  });
}

it.for([
  {
    status: "passed",
    code: 0,
    phases: [{ label: "unit", status: "passed", elapsedMs: 1250 }],
    expected: 0,
  },
  {
    status: "failed",
    code: 7,
    phases: [
      { label: "unit", status: "failed", elapsedMs: 500 },
      { label: "integration", status: "not-run" },
    ],
    expected: 7,
  },
  { status: "running", code: 0, phases: [{ label: "unit", status: "running" }], expected: 1 },
])(
  "reports $status qualification without treating incomplete work as a pass",
  ({ status, code, phases, expected }, { directory }) => {
    writeFileSync(join(directory, "exit-code"), String(code));
    writeFileSync(
      join(directory, "verification.json"),
      JSON.stringify({ node: "v26.0.0", status, phases }),
    );
    expect(run(directory, "verification", directory).status).toBe(expected);
    const summary = readFileSync(join(directory, "summary.md"), "utf8");
    expect(summary).toContain(expected === 0 ? "**Passed**" : "**Failed or incomplete**");
    for (const phase of phases) expect(summary).toContain(`| ${phase.label} | ${phase.status} |`);
  },
);

it("does not call missing or malformed evidence a successful qualification", ({ directory }) => {
  expect(run(directory, "verification", directory).status).toBe(2);
  writeFileSync(join(directory, "exit-code"), "0");
  writeFileSync(join(directory, "verification.json"), "sensitive malformed input");
  expect(run(directory, "verification", directory).status).toBe(2);
  const summary = readFileSync(join(directory, "summary.md"), "utf8");
  expect(summary).toContain("Evidence unavailable");
  expect(summary).not.toContain("sensitive malformed input");
  writeFileSync(join(directory, "exit-code"), "");
  writeFileSync(
    join(directory, "verification.json"),
    JSON.stringify({
      status: "passed",
      phases: [{ label: "unit", status: "passed" }],
    }),
  );
  expect(run(directory, "verification", directory).status).toBe(2);
});

it("retains remediation data without secret matches or code snippets", ({ directory }) => {
  const input = join(directory, "raw.json");
  const output = join(directory, "scan.json");
  writeFileSync(
    input,
    JSON.stringify({
      Metadata: { Arbitrary: "sensitive metadata" },
      Results: [
        {
          Target: "source.ts",
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-TEST",
              PkgName: "dependency",
              InstalledVersion: "1",
              FixedVersion: "2",
              Severity: "HIGH",
              Description: "arbitrary description",
            },
          ],
          Secrets: [
            {
              RuleID: "token",
              Severity: "HIGH",
              Match: "sensitive match",
              Code: { Lines: ["sensitive code"] },
            },
          ],
          Misconfigurations: [
            { ID: "AVD-TEST", Severity: "HIGH", CauseMetadata: { Code: "sensitive context" } },
          ],
        },
      ],
    }),
  );
  expect(run(directory, "scan-report", input, output).status).toBe(0);
  const report = readFileSync(output, "utf8");
  expect(report).not.toMatch(/sensitive|arbitrary/);
  expect(JSON.parse(report).Results).toEqual([
    {
      Target: "source.ts",
      Vulnerabilities: [
        {
          VulnerabilityID: "CVE-TEST",
          PkgName: "dependency",
          InstalledVersion: "1",
          FixedVersion: "2",
          Severity: "HIGH",
        },
      ],
      Secrets: [{ RuleID: "token", Severity: "HIGH" }],
      Misconfigurations: [{ ID: "AVD-TEST", Severity: "HIGH" }],
    },
  ]);
});
