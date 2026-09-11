import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SUMMARY_PATH = fileURLToPath(new URL("../trivy-filesystem-summary.sh", import.meta.url));

function runSummary(report, scanStatus) {
  const directory = mkdtempSync(join(tmpdir(), "pi-env-trivy-filesystem-summary-"));
  const reportPath = join(directory, "report.txt");
  writeFileSync(reportPath, report);

  try {
    return spawnSync("sh", [SUMMARY_PATH, reportPath, String(scanStatus)], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("filesystem Trivy reporting", () => {
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
    expect(result.stdout).toContain("CVE-TEST-50");
    expect(result.stdout).not.toContain("CVE-TEST-51");
    expect(result.stdout).toContain("Trivy omitted 2 additional finding(s) from the job log.");
  });
});
