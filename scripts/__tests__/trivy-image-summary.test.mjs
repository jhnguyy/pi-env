import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeReport } from "../trivy-image-summary.mjs";

const script = fileURLToPath(new URL("../trivy-image-summary.mjs", import.meta.url));
const vulnerability = (Severity, FixedVersion = "") => ({
  Severity,
  FixedVersion,
  VulnerabilityID: "CVE-test",
  PkgName: "package",
  InstalledVersion: "1",
});
const report = (result) => ({ Results: [result] });

function run(raw, summaryError = false) {
  const directory = mkdtempSync(join(tmpdir(), "trivy-image-"));
  try {
    const input = join(directory, "raw.json");
    const output = join(directory, "safe.json");
    const summary = summaryError ? directory : join(directory, "summary.md");
    writeFileSync(input, typeof raw === "string" ? raw : JSON.stringify(raw));
    if (!summaryError) writeFileSync(summary, "Existing summary\n");
    const result = spawnSync(process.execPath, [script, input, output], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    return {
      ...result,
      safe: result.status === 2 ? "" : readFileSync(output, "utf8"),
      summary: summaryError ? "" : readFileSync(summary, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Trivy image policy and safe evidence", () => {
  it("blocks only fixable high/critical vulnerabilities in mixed results", () => {
    const analysis = analyzeReport(
      report({
        Vulnerabilities: [
          vulnerability("CRITICAL"),
          vulnerability("HIGH", "2"),
          vulnerability("LOW", "2"),
          vulnerability("HIGH"),
        ],
      }),
    );
    expect(analysis.policyFailures).toBe(1);
    expect(analysis.unfixedHighCritical).toBe(2);
    expect(analysis.findings.filter((finding) => finding.blocking)).toMatchObject([
      { severity: "HIGH", fixed: "2", package: "package", installed: "1" },
    ]);
  });

  it("keeps unfixed and low findings informational", () => {
    const raw = report({ Vulnerabilities: [vulnerability("CRITICAL"), vulnerability("LOW", "2")] });
    expect(analyzeReport(raw).policyFailures).toBe(0);
    expect(run(raw).status).toBe(0);
  });

  it("blocks high secrets and critical misconfigurations, not low findings", () => {
    const analysis = analyzeReport(
      report({
        Secrets: [{ Severity: "HIGH", RuleID: "secret" }, { Severity: "LOW" }],
        Misconfigurations: [{ Severity: "CRITICAL", ID: "config" }],
      }),
    );
    expect(analysis.policyFailures).toBe(2);
    expect(
      analysis.findings.filter((finding) => finding.blocking).map((finding) => finding.id),
    ).toEqual(["secret", "config"]);
  });

  it("never exposes match/code or arbitrary metadata through analysis, evidence or rendering", () => {
    const raw = report({
      Target: "image",
      Metadata: "PRIVATE-CONTEXT",
      Secrets: [
        {
          Severity: "HIGH",
          RuleID: "rule|<script>",
          Match: "SECRET-VALUE",
          Code: { Lines: ["SECRET-VALUE"] },
          Title: "API key detected",
        },
      ],
      Vulnerabilities: [{ ...vulnerability("HIGH", "2"), PkgName: { Match: "SECRET-VALUE" } }],
    });
    const result = run(raw);
    expect(result.status).toBe(1);
    const retained = [
      JSON.stringify(analyzeReport(raw)),
      result.safe,
      result.stdout,
      result.stderr,
      result.summary,
    ];
    for (const text of retained) {
      expect(text).not.toContain("SECRET-VALUE");
      expect(text).not.toContain("PRIVATE-CONTEXT");
    }
    expect(JSON.parse(result.safe)).toEqual(analyzeReport(raw));
    expect(analyzeReport(raw).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "API key detected" })]),
    );
    expect(result.summary).toContain("Existing summary\n");
    expect(result.summary).not.toContain("<script>");
  });

  it.each(["invalid JSON", {}, { Results: [] }, { Results: [null] }, report({ Secrets: {} })])(
    "fails closed on unusable reports",
    (raw) => {
      expect(run(raw).status).toBe(2);
    },
  );

  it.each([
    [report({}), 0],
    [report({ Vulnerabilities: [vulnerability("HIGH", "2")] }), 1],
    ["invalid JSON", 2],
  ])("summary write failure cannot change policy status", (raw, status) => {
    expect(run(raw, true).status).toBe(status);
  });
});
