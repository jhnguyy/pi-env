import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../trivy-filesystem-summary.sh", import.meta.url));
function run(report, status) {
  const directory = mkdtempSync(join(tmpdir(), "trivy-source-"));
  try {
    const input = join(directory, "report.txt");
    const output = join(directory, "evidence.txt");
    const summary = join(directory, "summary.md");
    if (report !== null) writeFileSync(input, report);
    const result = spawnSync("sh", [script, input, String(status), output], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    return {
      ...result,
      evidence: existsSync(output) ? readFileSync(output, "utf8") : "",
      summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Trivy source reporting", () => {
  it.each([
    ["", 0, 0],
    ["", 1, 1],
    ["", 7, 7],
    [null, 0, 2],
    [null, 7, 7],
    ["SECRET HIGH rule", 0, 2],
    ["SECRET HIGH rule", 1, 1],
    ["SECRET HIGH rule", 7, 7],
  ])("preserves scanner failures and rejects contradictory success", (report, scan, expected) => {
    expect(run(report, scan).status).toBe(expected);
  });

  it("summarizes findings while retaining the template's remediation data", () => {
    const findings = [
      "VULNERABILITY HIGH CVE-test | package=example | installed=1 | fixed=2",
      "SECRET HIGH token-rule | title=API key detected | target=source.ts",
      "MISCONFIGURATION CRITICAL config-rule | title=Root user | target=Dockerfile",
    ];
    const result = run([...findings, "unrelated scanner context"].join("\n"), 1);
    expect(result.status).toBe(1);
    expect(result.evidence.trim().split("\n")).toEqual(findings);
    expect(result.summary).not.toContain("unrelated scanner context");
    expect(result.summary).toMatch(/Vulnerabilities.*1/);
    expect(result.summary).toMatch(/Secrets.*1/);
    expect(result.summary).toMatch(/Misconfigurations.*1/);
    expect(result.summary).toMatch(/Total.*3/);
  });

  it("bounds console findings without losing retained evidence", () => {
    const findings = Array.from({ length: 200 }, (_, index) => `VULNERABILITY HIGH CVE-${index}`);
    const result = run(findings.join("\n"), 1);
    const displayed = result.stdout.split("\n").filter((line) => line.startsWith("VULNERABILITY "));
    expect(displayed.length).toBeGreaterThan(0);
    expect(displayed.length).toBeLessThan(findings.length);
    expect(result.evidence.trim().split("\n")).toEqual(findings);
  });
});
