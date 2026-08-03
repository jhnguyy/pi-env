#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const [jsonPath] = process.argv.slice(2);
if (!jsonPath) {
  console.error('usage: scripts/trivy-image-summary.mjs <trivy-results.json>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
const severityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
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
    const severity = String(vuln.Severity ?? 'UNKNOWN').toUpperCase();
    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1;
    if (severity === 'HIGH' || severity === 'CRITICAL') {
      if (vuln.FixedVersion) {
        policyFindings.push({
          kind: 'vuln',
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
    const severity = String(secret.Severity ?? 'UNKNOWN').toUpperCase();
    if (severity === 'HIGH' || severity === 'CRITICAL') {
      policyFindings.push({
        kind: 'secret',
        severity,
        id: secret.RuleID,
        package: secret.Category ?? 'secret',
        installed: '-',
        fixed: '-',
        target: result.Target,
      });
    }
  }

  for (const misconfig of result.Misconfigurations ?? []) {
    misconfigCount += 1;
    const severity = String(misconfig.Severity ?? 'UNKNOWN').toUpperCase();
    if (severity === 'HIGH' || severity === 'CRITICAL') {
      policyFindings.push({
        kind: 'misconfig',
        severity,
        id: misconfig.ID,
        package: misconfig.Type ?? 'misconfig',
        installed: '-',
        fixed: '-',
        target: result.Target,
      });
    }
  }
}

console.log('Trivy built-image scan summary');
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

if (policyFindings.length > 0) {
  console.log('\nPolicy findings (first 50):');
  for (const finding of policyFindings.slice(0, 50)) {
    console.log(`${finding.kind.toUpperCase()} ${finding.severity} ${finding.id} ${finding.package} ${finding.installed} -> ${finding.fixed} (${finding.target})`);
  }
  process.exit(1);
}
