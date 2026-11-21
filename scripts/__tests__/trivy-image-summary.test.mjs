import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

function runReport(report, { summaryError = false, summaryEnabled = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-env-trivy-summary-"));
  const reportPath = join(directory, "report.json");
  if (report !== null)
    writeFileSync(reportPath, typeof report === "string" ? report : JSON.stringify(report));
  const summaryPath = summaryError ? directory : join(directory, "summary.md");
  if (!summaryError) writeFileSync(summaryPath, "Existing summary\n");

  try {
    const result = spawnSync(process.execPath, [SUMMARY_PATH, reportPath], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryEnabled ? summaryPath : "" },
    });
    return { ...result, summary: summaryError ? "" : readFileSync(summaryPath, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runSummary(result) {
  return runReport({ Results: [result] });
}

describe("built-image Trivy policy", () => {
  it("leaves console output and status unchanged without a summary destination", () => {
    const report = {
      Results: [{ Vulnerabilities: [vulnerability({ severity: "HIGH", fixedVersion: "2" })] }],
    };
    const enabled = runReport(report);
    const disabled = runReport(report, { summaryEnabled: false });
    expect(disabled.status).toBe(enabled.status);
    expect(disabled.stdout).toBe(enabled.stdout);
    expect(disabled.stderr).toBe(enabled.stderr);
    expect(disabled.summary).toBe("Existing summary\n");
  });

  it("bounds summary finding IDs and reports omitted findings", () => {
    const result = runReport({
      Results: [
        {
          Vulnerabilities: Array.from({ length: 52 }, (_, index) =>
            vulnerability({ severity: "HIGH", fixedVersion: "2", id: `CVE${index}` }),
          ),
        },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.summary).toContain("CVE49");
    expect(result.summary).not.toContain("CVE50");
    expect(result.summary).toContain("2 additional finding(s) omitted.");
  });

  it("appends a truthful passing summary with unfixed vulnerabilities", () => {
    const result = runReport({
      Results: [
        {
          Vulnerabilities: [
            vulnerability({ severity: "HIGH" }),
            vulnerability({ severity: "LOW" }),
          ],
        },
      ],
    });
    expect(result.status).toBe(0);
    expect(result.summary).toContain("Existing summary\n");
    expect(result.summary).toContain("Policy passed");
    expect(result.summary).toContain("not a vulnerability-free image");
    expect(result.summary).toContain("| Total vulnerabilities (all reported severities) | 2 |");
    expect(result.summary).toContain("| Actionable fixable HIGH/CRITICAL vulnerabilities | 0 |");
    expect(result.summary).toContain(
      "| Unfixed HIGH/CRITICAL vulnerabilities (informational, not blocking) | 1 |",
    );
  });

  it("summarizes policy IDs safely without secret context", () => {
    const result = runReport({
      Results: [
        {
          Target: "PRIVATE-CONTEXT",
          Vulnerabilities: [vulnerability({ severity: "HIGH", fixedVersion: "2" })],
          Secrets: [
            {
              Severity: "HIGH",
              RuleID: "rule|<script>\n[x](url)`",
              Match: "SECRET-VALUE",
              Title: "PRIVATE-CONTEXT",
              Code: { Lines: ["SECRET-VALUE"] },
            },
          ],
        },
      ],
    });
    expect(result.status).toBe(1);
    expect(result.summary).toContain("Policy failed");
    expect(result.summary).toContain("| Actionable fixable HIGH/CRITICAL vulnerabilities | 1 |");
    expect(result.summary).toContain("rule&#124;&#60;script&#62; &#91;x&#93;&#40;url&#41;&#96;");
    expect(result.summary).not.toContain("SECRET-VALUE");
    expect(result.summary).not.toContain("PRIVATE-CONTEXT");
  });

  it.each([null, "invalid JSON", { Results: [] }])(
    "reports unusable evidence as an error",
    (report) => {
      const result = runReport(report);
      expect(result.status).toBe(2);
      expect(result.summary).toContain("Scanner/report error");
      expect(result.summary).not.toContain("Policy passed");
    },
  );

  it.each([
    [{ Results: [{}] }, 0],
    [
      { Results: [{ Vulnerabilities: [vulnerability({ severity: "HIGH", fixedVersion: "2" })] }] },
      1,
    ],
    ["invalid JSON", 2],
  ])("preserves exit status when the summary cannot be written", (report, status) => {
    const result = runReport(report, { summaryError: true });
    expect(result.status).toBe(status);
    expect(result.stderr).toContain("Could not append");
  });

  it("rejects reports that contain no scanned targets", () => {
    const result = runReport({ Results: [] });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Trivy image scan did not report any targets.");
  });

  it.each(["CRITICAL", "HIGH"])("keeps an unfixed %s vulnerability informational", (severity) => {
    const result = runSummary({
      Target: "test-image",
      Vulnerabilities: [vulnerability({ severity })],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Ignored unfixed HIGH/CRITICAL vulnerabilities: 1");
    expect(result.stdout).toContain("Policy findings: 0");
  });

  it.each(["CRITICAL", "HIGH"])("fails for a fixable %s vulnerability", (severity) => {
    const result = runSummary({
      Target: "test-image",
      Vulnerabilities: [vulnerability({ severity, fixedVersion: "1.2.3" })],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Ignored unfixed HIGH/CRITICAL vulnerabilities: 0");
    expect(result.stdout).toContain("Policy findings: 1");
    expect(result.stdout).toContain(
      `VULN ${severity} CVE-TEST-${severity} ${severity.toLowerCase()}-package 1.0.0 -> 1.2.3 (test-image)`,
    );
  });

  it("counts unfixed high and critical vulnerabilities as informational in mixed results", () => {
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
    expect(result.stdout).toContain("Ignored unfixed HIGH/CRITICAL vulnerabilities: 2");
    expect(result.stdout).toContain("Policy findings: 1");
    expect(result.stdout.split("\n").filter((line) => line.startsWith("VULN "))).toEqual([
      "VULN HIGH CVE-TEST-HIGH-FIXED high-package 1.0.0 -> 1.2.3 (test-image)",
    ]);
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
