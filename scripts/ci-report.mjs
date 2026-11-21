#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cell = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replace(/[\r\n]/g, " ");
const summary = (markdown) => {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
};

function verification(directory) {
  const status = readFileSync(join(directory, "exit-code"), "utf8").trim();
  const exitCode = Number(status);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(status) || exitCode > 255)
    throw new Error("Invalid verification exit status.");
  const report = JSON.parse(readFileSync(join(directory, "verification.json"), "utf8"));
  if (!Array.isArray(report.phases) || !report.phases.length)
    throw new Error("Missing verification phases.");
  const passed =
    exitCode === 0 &&
    report.status === "passed" &&
    report.phases.every((phase) => phase.status === "passed");
  const toolchainPath = join(directory, "toolchain.txt");
  const toolchain = existsSync(toolchainPath)
    ? cell(readFileSync(toolchainPath, "utf8").trim())
    : "Toolchain inventory unavailable";
  const rows = report.phases.map(
    (phase) =>
      `| ${cell(phase.label)} | ${cell(phase.status)} | ${phase.elapsedMs === undefined ? "—" : `${(phase.elapsedMs / 1000).toFixed(2)}s`} |`,
  );
  summary(
    [
      "## Full verification",
      "",
      `**${passed ? "Passed" : "Failed or incomplete"}** · Verification Node ${cell(report.node)} · exit ${exitCode}`,
      "",
      toolchain,
      "",
      "| Phase | Result | Duration |",
      "| --- | --- | --- |",
      ...rows,
      "",
      "Download **image-evidence** for phase results, toolchain versions, and JUnit reports from completed test phases. Not-run phases are not qualified. JUnit omits captured console output; failures retain assertion diagnostics.",
    ].join("\n"),
  );
  return passed ? 0 : exitCode || 1;
}

function scanReport(input, output) {
  const report = JSON.parse(readFileSync(input, "utf8"));
  // Retain scanner identities and remediation data, never secret matches, source
  // snippets, or arbitrary scanner metadata. The raw report stays runner-local.
  const pick = (object, keys) =>
    Object.fromEntries(
      keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]),
    );
  const sanitized = {
    Results: (report.Results ?? []).map((result) => ({
      ...pick(result, ["Target", "Class", "Type"]),
      Vulnerabilities: (result.Vulnerabilities ?? []).map((finding) =>
        pick(finding, [
          "VulnerabilityID",
          "PkgName",
          "InstalledVersion",
          "FixedVersion",
          "Severity",
          "Status",
        ]),
      ),
      Secrets: (result.Secrets ?? []).map((finding) =>
        pick(finding, ["RuleID", "Category", "Severity"]),
      ),
      Misconfigurations: (result.Misconfigurations ?? []).map((finding) =>
        pick(finding, ["ID", "Type", "Severity", "Status"]),
      ),
    })),
  };
  writeFileSync(output, `${JSON.stringify(sanitized, null, 2)}\n`);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verification" && args.length === 1) process.exitCode = verification(args[0]);
  else if (command === "scan-report" && args.length === 2) scanReport(...args);
  else
    throw new Error("usage: ci-report.mjs verification <directory> | scan-report <input> <output>");
} catch {
  summary(
    "## Evidence unavailable\n\nThe verification or scanner report is missing or invalid. This is not a successful qualification; inspect the preceding job steps.",
  );
  process.exitCode = 2;
}
