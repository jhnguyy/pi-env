import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NODE_RUNNER_PATH = fileURLToPath(new URL("../node-run.sh", import.meta.url));
const SUMMARY_PATH = fileURLToPath(new URL("../trivy-image-summary.mjs", import.meta.url));

function vulnerability({ severity, fixedVersion = "", id = `CVE-TEST-${severity}` }) {
  return {
    Severity: severity,
    VulnerabilityID: id,
    PkgName: `${severity.toLowerCase()}-package`,
    InstalledVersion: "1.0.0",
    FixedVersion: fixedVersion,
  };
}

function runSummary(result) {
  const directory = mkdtempSync(join(tmpdir(), "pi-env-trivy-summary-"));
  const reportPath = join(directory, "report.json");
  writeFileSync(reportPath, JSON.stringify({ Results: [result] }));

  try {
    return spawnSync(NODE_RUNNER_PATH, [SUMMARY_PATH, reportPath], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("built-image Trivy policy", () => {
  it("fails for an unfixed critical vulnerability", () => {
    const result = runSummary({
      Target: "test-image",
      Vulnerabilities: [vulnerability({ severity: "CRITICAL" })],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Critical: 1");
    expect(result.stdout).toContain("High: 0");
    expect(result.stdout).toContain("Ignored unfixed HIGH/CRITICAL vulnerabilities: 0");
    expect(result.stdout).toContain("Policy findings: 1");
    expect(result.stdout).toContain(
      "VULN CRITICAL CVE-TEST-CRITICAL critical-package 1.0.0 -> unfixed (test-image)",
    );
  });

  it("keeps an unfixed high vulnerability informational", () => {
    const result = runSummary({
      Target: "test-image",
      Vulnerabilities: [vulnerability({ severity: "HIGH" })],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("High: 1");
    expect(result.stdout).toContain("Ignored unfixed HIGH/CRITICAL vulnerabilities: 1");
    expect(result.stdout).toContain("Policy findings: 0");
    expect(result.stdout).not.toContain("Policy findings (first 50):");
  });

  it("fails for a fixable high vulnerability", () => {
    const result = runSummary({
      Target: "test-image",
      Vulnerabilities: [vulnerability({ severity: "HIGH", fixedVersion: "1.2.3" })],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Ignored unfixed HIGH/CRITICAL vulnerabilities: 0");
    expect(result.stdout).toContain("Policy findings: 1");
    expect(result.stdout).toContain(
      "VULN HIGH CVE-TEST-HIGH high-package 1.0.0 -> 1.2.3 (test-image)",
    );
  });

  it("counts only unfixed high vulnerabilities as informational in mixed results", () => {
    const result = runSummary({
      Target: "test-image",
      Vulnerabilities: [
        vulnerability({ severity: "CRITICAL" }),
        vulnerability({ severity: "HIGH" }),
        vulnerability({ severity: "HIGH", fixedVersion: "1.2.3", id: "CVE-TEST-HIGH-FIXED" }),
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Critical: 1");
    expect(result.stdout).toContain("High: 2");
    expect(result.stdout).toContain("Ignored unfixed HIGH/CRITICAL vulnerabilities: 1");
    expect(result.stdout).toContain("Policy findings: 2");
  });

  it("preserves high-severity secret and misconfiguration enforcement", () => {
    const result = runSummary({
      Target: "test-image",
      Secrets: [{ Severity: "HIGH", RuleID: "secret-rule", Category: "token" }],
      Misconfigurations: [{ Severity: "CRITICAL", ID: "config-rule", Type: "dockerfile" }],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Secrets: 1");
    expect(result.stdout).toContain("Misconfigurations: 1");
    expect(result.stdout).toContain("Policy findings: 2");
    expect(result.stdout).toContain("SECRET HIGH secret-rule token - -> - (test-image)");
    expect(result.stdout).toContain(
      "MISCONFIG CRITICAL config-rule dockerfile - -> - (test-image)",
    );
  });
});
