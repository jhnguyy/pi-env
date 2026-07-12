import { FailPolicy, OutputMode, type AnalysisResult } from "./model.js";

const clean = (s: string): string => s.replaceAll("\t", " ").replaceAll("\n", " ");
const prettyLocation = (location: { path: string; line: number; column: number }): string =>
  `${location.path}:${location.line}:${location.column}`;

export function formatResult(result: AnalysisResult, mode: OutputMode): string {
  if (mode === OutputMode.Json) return JSON.stringify(result, null, 2);
  if (mode === OutputMode.Pretty) {
    return [
      ...result.findings.flatMap((finding) => [
        `${finding.severity.toUpperCase()} ${prettyLocation(finding.location)} ${finding.message}`,
        ...(finding.related ?? []).map((related) => `  related: ${prettyLocation(related)}`),
      ]),
      ...result.analyzerFailures.map((failure) => `FAIL ${failure.analyzer}: ${failure.message}`),
      `Summary: ${result.summary.error} errors, ${result.summary.warning} warnings, ${result.summary.info} info, ${result.summary.failures} failures`,
    ].join("\n");
  }
  return [
    ...result.findings.map((finding) => [finding.severity, finding.analyzer, prettyLocation(finding.location), finding.id, clean(finding.message)].join("\t")),
    ...result.analyzerFailures.map((failure) => ["failure", failure.analyzer, "-", "-", clean(failure.message)].join("\t")),
  ].join("\n");
}

export function shouldFail(result: AnalysisResult, policy: FailPolicy): boolean {
  if (result.analyzerFailures.length > 0) return true;
  if (policy === FailPolicy.Never) return false;
  if (policy === FailPolicy.Error) return result.summary.error > 0;
  return result.summary.error + result.summary.warning > 0;
}
