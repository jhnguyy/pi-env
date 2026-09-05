import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOCK_PATH = join(ROOT, "lock.yaml");
const PACKAGE_PATH = join(ROOT, "package.json");
const SUMMARY_PATH = join(ROOT, "scripts/trivy-filesystem-summary.sh");
const WORKFLOW_PATH = join(ROOT, ".github/workflows/trivy.yml");

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

  it("does not dump raw Trivy JSON from the workflow", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).not.toMatch(/\bcat\s+\/tmp\/trivy-[^\n]*\.json/);
    expect(workflow).toContain("--format template");
  });

  it("locks every undici consumer to the fixed release", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
    const lockfile = readFileSync(LOCK_PATH, "utf8");
    const packageVersions = [...lockfile.matchAll(/^  undici@([^:]+):$/gm)].map(
      ([, version]) => version,
    );
    const consumerVersions = [...lockfile.matchAll(/^\s+undici: (\S+)$/gm)].map(
      ([, version]) => version,
    );

    expect(manifest.overrides.undici).toBe("8.9.0");
    expect(packageVersions).toEqual(["8.9.0"]);
    expect(new Set(consumerVersions)).toEqual(new Set(["8.9.0"]));
  });

  it("locks every toml consumer to the fixed release", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_PATH, "utf8"));
    const lockfile = readFileSync(LOCK_PATH, "utf8");
    const packageVersions = [...lockfile.matchAll(/^  toml@([^:]+):$/gm)].map(
      ([, version]) => version,
    );
    const consumerVersions = [...lockfile.matchAll(/^\s+toml: (\S+)$/gm)].map(
      ([, version]) => version,
    );

    expect(manifest.overrides.toml).toBe("4.2.0");
    expect(packageVersions).toEqual(["4.2.0"]);
    expect(new Set(consumerVersions)).toEqual(new Set(["4.2.0"]));
  });
});
