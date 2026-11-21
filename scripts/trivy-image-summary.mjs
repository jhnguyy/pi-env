#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

function appendSummary(body) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n## Trivy built-image scan\n\n${body}\n`);
  } catch {
    console.error("Could not append Trivy image step summary.");
  }
}

function markdown(value) {
  return String(value ?? "unknown")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[^a-zA-Z0-9 ]/g, (character) => `&#${character.codePointAt(0)};`);
}

const [jsonPath] = process.argv.slice(2);
if (!jsonPath) {
  console.error("usage: scripts/trivy-image-summary.mjs <trivy-results.json>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch {
  appendSummary(
    "Scanner/report error: image report is unreadable or invalid JSON. Policy result unavailable.",
  );
  console.error("Trivy image scan returned invalid JSON.");
  process.exit(2);
}

if (!Array.isArray(report?.Results) || report.Results.length === 0) {
  appendSummary("Scanner/report error: no scanned targets reported. Policy result unavailable.");
  console.error("Trivy image scan did not report any targets.");
  process.exit(2);
}

const severityOrder = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"];
const severityCounts = Object.fromEntries(severityOrder.map((severity) => [severity, 0]));
const policyFindings = [];
let vulnerabilityCount = 0;
let ignoredUnfixedHighCritical = 0;
let secretCount = 0;
let misconfigCount = 0;
let targetCount = 0;

for (const result of report.Results ?? []) {
  targetCount += 1;
  for (const vuln of result.Vulnerabilities ?? []) {
    vulnerabilityCount += 1;
    const severity = String(vuln.Severity ?? "UNKNOWN").toUpperCase();
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
    if (severity === "HIGH" || severity === "CRITICAL") {
      if (vuln.FixedVersion) {
        policyFindings.push({
          kind: "vuln",
          severity,
          id: vuln.VulnerabilityID,
          package: vuln.PkgName,
          installed: vuln.InstalledVersion,
          fixed: vuln.FixedVersion,
          target: result.Target,
        });
      } else {
        ignoredUnfixedHighCritical += 1;
      }
    }
  }

  for (const secret of result.Secrets ?? []) {
    secretCount += 1;
    const severity = String(secret.Severity ?? "UNKNOWN").toUpperCase();
    if (severity === "HIGH" || severity === "CRITICAL") {
      policyFindings.push({
        kind: "secret",
        severity,
        id: secret.RuleID,
        package: secret.Category ?? "secret",
        installed: "-",
        fixed: "-",
        target: result.Target,
      });
    }
  }

  for (const misconfig of result.Misconfigurations ?? []) {
    misconfigCount += 1;
    const severity = String(misconfig.Severity ?? "UNKNOWN").toUpperCase();
    if (severity === "HIGH" || severity === "CRITICAL") {
      policyFindings.push({
        kind: "misconfig",
        severity,
        id: misconfig.ID,
        package: misconfig.Type ?? "misconfig",
        installed: "-",
        fixed: "-",
        target: result.Target,
      });
    }
  }
}

console.log("Trivy built-image scan summary");
console.log(`Targets scanned: ${targetCount}`);
console.log(`HIGH/CRITICAL vulnerabilities: ${vulnerabilityCount}`);
console.log(`  Critical: ${severityCounts.CRITICAL ?? 0}`);
console.log(`  High: ${severityCounts.HIGH ?? 0}`);
console.log(`  Medium: ${severityCounts.MEDIUM ?? 0}`);
console.log(`  Low: ${severityCounts.LOW ?? 0}`);
console.log(`  Unknown: ${severityCounts.UNKNOWN ?? 0}`);
console.log(`Secrets: ${secretCount}`);
console.log(`Misconfigurations: ${misconfigCount}`);
console.log(`Ignored unfixed HIGH/CRITICAL vulnerabilities: ${ignoredUnfixedHighCritical}`);
console.log(`Policy findings: ${policyFindings.length}`);

const actionableVulnerabilities = policyFindings.filter(
  (finding) => finding.kind === "vuln",
).length;
const summary = [
  policyFindings.length > 0
    ? "Policy failed: actionable HIGH/CRITICAL findings."
    : "Policy passed: no actionable HIGH/CRITICAL findings (not a vulnerability-free image).",
  "",
  "| Metric | Count |",
  "| --- | ---: |",
  `| Targets scanned | ${targetCount} |`,
  `| Total vulnerabilities (all reported severities) | ${vulnerabilityCount} |`,
  `| Critical vulnerabilities | ${severityCounts.CRITICAL} |`,
  `| High vulnerabilities | ${severityCounts.HIGH} |`,
  `| Actionable fixable HIGH/CRITICAL vulnerabilities | ${actionableVulnerabilities} |`,
  `| Unfixed HIGH/CRITICAL vulnerabilities (informational, not blocking) | ${ignoredUnfixedHighCritical} |`,
  `| Secrets (all reported severities) | ${secretCount} |`,
  `| Misconfigurations (all reported severities) | ${misconfigCount} |`,
  `| Policy findings (including HIGH/CRITICAL secrets and misconfigurations) | ${policyFindings.length} |`,
];
if (policyFindings.length > 0) {
  summary.push("", "Policy finding IDs (first 50; no secret matches or report context):", "");
  for (const finding of policyFindings.slice(0, 50)) {
    summary.push(`- ${finding.kind.toUpperCase()} ${finding.severity}: ${markdown(finding.id)}`);
  }
  if (policyFindings.length > 50)
    summary.push(`\n${policyFindings.length - 50} additional finding(s) omitted.`);
}
appendSummary(summary.join("\n"));

if (policyFindings.length > 0) {
  console.log("\nPolicy findings (first 50):");
  for (const finding of policyFindings.slice(0, 50)) {
    console.log(
      `${finding.kind.toUpperCase()} ${finding.severity} ${finding.id} ${finding.package} ${finding.installed} -> ${finding.fixed} (${finding.target})`,
    );
  }
  process.exit(1);
}
