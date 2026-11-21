import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SUMMARY_PATH = fileURLToPath(new URL("../trivy-filesystem-summary.sh", import.meta.url));

function runSummary(report, scanStatus, { summaryError = false, summaryEnabled = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-env-trivy-filesystem-summary-"));
  const reportPath = join(directory, "report.txt");
  if (report !== null) writeFileSync(reportPath, report);
  const summaryPath = summaryError ? directory : join(directory, "summary.md");
  if (!summaryError) writeFileSync(summaryPath, "Existing summary\n");

  try {
    const result = spawnSync("sh", [SUMMARY_PATH, reportPath, String(scanStatus)], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryEnabled ? summaryPath : "" },
    });
    return { ...result, summary: summaryError ? "" : readFileSync(summaryPath, "utf8") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("filesystem Trivy reporting", () => {
  it("preserves console output and status without a summary destination", () => {
    const report = "SECRET HIGH rule | title=context";
    const enabled = runSummary(report, 1);
    const disabled = runSummary(report, 1, { summaryEnabled: false });
    expect(disabled.status).toBe(enabled.status);
    expect(disabled.stdout).toBe(enabled.stdout);
    expect(disabled.stderr).toBe(enabled.stderr);
    expect(disabled.summary).toBe("Existing summary\n");
  });

  it("appends counts without copying template context or secret matches", () => {
    const result = runSummary(
      [
        "VULNERABILITY HIGH CVE-TEST | package=<script>|target=[x](url)",
        "SECRET HIGH rule | title=SECRET-VALUE | target=PRIVATE-CONTEXT",
        "MISCONFIGURATION CRITICAL config | title=PRIVATE-CONTEXT",
        "context snippet SECRET-VALUE",
      ].join("\n"),
      1,
    );
    expect(result.status).toBe(1);
    expect(result.summary).toContain("Existing summary\n");
    expect(result.summary).toContain("Policy findings");
    expect(result.summary).toContain("| Vulnerabilities | 1 |");
    expect(result.summary).toContain("| Secrets | 1 |");
    expect(result.summary).toContain("| Misconfigurations | 1 |");
    expect(result.summary).toContain("| Total | 3 |");
    for (const context of ["SECRET-VALUE", "PRIVATE-CONTEXT", "<script>", "[x](url)"]) {
      expect(result.summary).not.toContain(context);
    }
  });

  it.each([
    ["", 0, 0, "Scanner succeeded"],
    ["", 1, 1, "Scanner error"],
    ["", 7, 7, "Scanner error"],
    [null, 0, 2, "Scanner/report error"],
    [null, 7, 7, "Scanner/report error"],
    ["SECRET HIGH rule | title=context", 0, 2, "Scanner/report error"],
    ["SECRET HIGH rule | title=context", 7, 7, "Scanner error"],
  ])(
    "distinguishes scanner outcomes and preserves report failures",
    (report, scanStatus, status, message) => {
      const result = runSummary(report, scanStatus);
      expect(result.status).toBe(status);
      expect(result.summary).toContain(message);
      expect(result.summary).toContain(`Scanner exit status: ${scanStatus}`);
      if (status !== 0) expect(result.summary).not.toContain("Scanner succeeded");
    },
  );

  it.each([
    ["", 0, 0],
    ["SECRET HIGH rule", 1, 1],
    [null, 7, 7],
    [null, 0, 2],
  ])(
    "preserves scan and report status when summary writing fails",
    (report, scanStatus, status) => {
      const result = runSummary(report, scanStatus, { summaryError: true });
      expect(result.status).toBe(status);
      expect(result.stderr).toContain("Could not append");
    },
  );

  it("reports each actionable vulnerability on one compact line", () => {
    const result = runSummary(
      [
        "VULNERABILITY HIGH CVE-2026-13697 | package=undici | installed=8.5.0 | fixed=8.9.0 | target=lock.yaml",
        "VULNERABILITY HIGH CVE-2026-13697 | package=undici | installed=8.7.0 | fixed=8.9.0 | target=lock.yaml",
        "",
      ].join("\n"),
      1,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "Trivy policy: 2 actionable HIGH/CRITICAL finding(s).",
      "VULNERABILITY HIGH CVE-2026-13697 | package=undici | installed=8.5.0 | fixed=8.9.0 | target=lock.yaml",
      "VULNERABILITY HIGH CVE-2026-13697 | package=undici | installed=8.7.0 | fixed=8.9.0 | target=lock.yaml",
    ]);
  });

  it.each(["", '{"SchemaVersion":2}\n'])(
    "distinguishes a scanner failure from policy findings",
    (report) => {
      const result = runSummary(report, 1);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "Trivy scanner failed before it produced actionable findings.",
      );
    },
  );

  it("reports a successful scan without raw report content", () => {
    const result = runSummary("\n", 0);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Trivy policy: no actionable HIGH/CRITICAL findings.\n");
  });

  it("limits policy output to 50 finding lines", () => {
    const report = Array.from(
      { length: 52 },
      (_, index) =>
        `VULNERABILITY HIGH CVE-TEST-${index + 1} | package=test | installed=1 | fixed=2 | target=lock.yaml`,
    ).join("\n");
    const result = runSummary(report, 1);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Trivy policy: 52 actionable HIGH/CRITICAL finding(s).");
    expect(result.stdout.split("\n").filter((line) => line.startsWith("VULNERABILITY "))).toEqual(
      report.split("\n").slice(0, 50),
    );
    expect(result.stdout).toContain("Trivy omitted 2 additional finding(s) from the job log.");
  });
});
