#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const text = (value) => (typeof value === "string" ? value : "");
const highCritical = (severity) => ["HIGH", "CRITICAL"].includes(severity);

function safeFinding(entry, kind, id, target) {
  if (!entry || typeof entry !== "object") throw new Error("Invalid finding.");
  const severity = text(entry.Severity).toUpperCase() || "UNKNOWN";
  const vulnerability = kind === "vulnerability";
  const fixed = vulnerability ? text(entry.FixedVersion) : "";
  return {
    kind,
    id: text(entry[id]),
    title: text(entry.Title),
    severity,
    target: text(target),
    package: vulnerability ? text(entry.PkgName) : "",
    installed: vulnerability ? text(entry.InstalledVersion) : "",
    fixed,
    blocking: highCritical(severity) && (!vulnerability || Boolean(fixed.trim())),
  };
}

// Retain scanner identities, rule metadata, and remediation—not matches or source code.
export function analyzeReport(report) {
  if (!Array.isArray(report?.Results) || !report.Results.length)
    throw new Error("No scanned targets reported.");
  const findings = [];
  for (const result of report.Results) {
    if (!result || typeof result !== "object") throw new Error("Invalid target.");
    for (const [key, kind, id] of [
      ["Vulnerabilities", "vulnerability", "VulnerabilityID"],
      ["Secrets", "secret", "RuleID"],
      ["Misconfigurations", "misconfiguration", "ID"],
    ]) {
      const entries = result[key] ?? [];
      if (!Array.isArray(entries)) throw new Error("Invalid findings.");
      for (const entry of entries) {
        findings.push(safeFinding(entry, kind, id, result.Target));
      }
    }
  }
  return {
    targets: report.Results.length,
    findings,
    policyFailures: findings.filter((finding) => finding.blocking).length,
    unfixedHighCritical: findings.filter(
      (finding) =>
        finding.kind === "vulnerability" && !finding.fixed.trim() && highCritical(finding.severity),
    ).length,
  };
}

const markdown = (value) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/[^a-zA-Z0-9 ]/g, (character) => `&#${character.codePointAt(0)};`);

function run() {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || extra.length) {
    console.error("usage: scripts/trivy-image-summary.mjs <raw-json> [safe-output-json]");
    return 2;
  }
  let analysis;
  try {
    analysis = analyzeReport(JSON.parse(readFileSync(input, "utf8")));
    if (output) writeFileSync(output, `${JSON.stringify(analysis, null, 2)}\n`);
  } catch {
    console.error("Trivy image policy report could not be evaluated or retained.");
    return 2;
  }
  const blocking = analysis.findings.filter((finding) => finding.blocking);
  const displayed = blocking.slice(0, 50);
  const body = `## Trivy built-image findings

Targets scanned: ${analysis.targets}
Reported findings: ${analysis.findings.length}
Unfixed HIGH/CRITICAL vulnerabilities (informational): ${analysis.unfixedHighCritical}
Actionable HIGH/CRITICAL findings: ${analysis.policyFailures}

Only fixable HIGH/CRITICAL vulnerabilities and HIGH/CRITICAL secrets or misconfigurations block. A passing policy does not mean a vulnerability-free image.

${displayed.map((finding) => `- ${finding.kind} ${finding.severity}: ${markdown(finding.id)}${finding.title ? ` — ${markdown(finding.title)}` : ""}`).join("\n")}
${blocking.length > displayed.length ? `\n${blocking.length - displayed.length} more actionable findings.` : ""}
${output ? "\nThe retained report includes all finding identities and remediation data, without secret matches or code context." : ""}
`;
  console.log(body);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${body}`);
    } catch {
      console.error("Could not append Trivy image step summary.");
    }
  }
  return analysis.policyFailures ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = run();
