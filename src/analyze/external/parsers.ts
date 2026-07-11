import { relative, resolve } from "node:path";
import type { Metafile } from "esbuild";
import { AnalyzerName, FindingKind, Severity, type Finding } from "../model.js";

const slash = (value: string): string => value.replaceAll("\\", "/");

interface DependencyViolation {
  from?: string;
  to?: string;
  rule: { name: string; severity: "error" | "warn" | "info" | "ignore" };
  cycle?: readonly string[];
}

function invalidDependencyCruiserJson(message: string): never { throw new Error(`Invalid dependency-cruiser report: ${message}`); }
function dependencyObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidDependencyCruiserJson(`${context} must be an object`);
  return value as Record<string, unknown>;
}
function optionalDependencyString(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalidDependencyCruiserJson(`${context} must be a string`);
  return value;
}
function dependencyViolation(value: unknown, context: string): DependencyViolation {
  const item = dependencyObject(value, context);
  const rule = dependencyObject(item.rule, `${context}.rule`);
  const severity = optionalDependencyString(rule.severity, `${context}.rule.severity`) ?? "warn";
  if (severity !== "error" && severity !== "warn" && severity !== "info" && severity !== "ignore") invalidDependencyCruiserJson(`${context}.rule.severity is not supported`);
  const cycle = item.cycle;
  if (cycle !== undefined && (!Array.isArray(cycle) || !cycle.every((entry) => typeof entry === "string"))) invalidDependencyCruiserJson(`${context}.cycle must be an array of strings`);
  const cycleValues = cycle === undefined ? undefined : cycle as string[];
  return {
    from: optionalDependencyString(item.from, `${context}.from`),
    to: optionalDependencyString(item.to, `${context}.to`),
    rule: { name: optionalDependencyString(rule.name, `${context}.rule.name`) ?? "dependency violation", severity },
    cycle: cycleValues,
  };
}

export function parseDependencyCruiserJson(text: string): Finding[] {
  const report = dependencyObject(JSON.parse(text), "dependency-cruiser report");
  const summary = dependencyObject(report.summary, "dependency-cruiser report.summary");
  if (!Array.isArray(summary.violations)) invalidDependencyCruiserJson("dependency-cruiser report.summary.violations must be an array");
  return summary.violations.map((value, index) => dependencyViolation(value, `dependency-cruiser report.summary.violations[${index}]`)).map((violation) => {
    const from = slash(violation.from ?? violation.cycle?.[0] ?? ".");
    const target = violation.to ?? violation.cycle?.[1] ?? "unknown target";
    return {
      id: "",
      analyzer: AnalyzerName.Dependencies,
      kind: FindingKind.Dependency,
      severity: violation.rule.severity === "error" ? Severity.Error : Severity.Warning,
      message: `${violation.rule.name}: ${from} -> ${target}`,
      location: { path: from, line: 1, column: 1 },
      data: { rule: violation.rule.name, target, cycle: violation.cycle },
    };
  });
}

export function parseKnipOutput(text: string): Finding[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headings = lines.filter((line) => /^(Unused|Unlisted|Unresolved|Duplicate|Configuration)/i.test(line));
  if (headings.length === 0 && lines.length === 0) return [];
  const message = headings.length > 0
    ? `Knip advisory: ${headings.join("; ")}`
    : `Knip advisory (legacy adapter text): ${lines.slice(0, 5).join("; ")}`;
  return [{ id: "", analyzer: AnalyzerName.Knip, kind: FindingKind.Dependency, severity: Severity.Warning, message, location: { path: ".", line: 1, column: 1 } }];
}

interface BundleInputSummary {
  outputBytes: number;
  inputCount: number;
  packageInputCount: number;
  importKinds: Readonly<Record<string, number>>;
}

export function normalizeBundleMetafile(metafile: Metafile): BundleInputSummary {
  const imports: Record<string, number> = {};
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input.imports) imports[imported.kind] = (imports[imported.kind] ?? 0) + 1;
  }
  return {
    outputBytes: Object.values(metafile.outputs).reduce((total, output) => total + output.bytes, 0),
    inputCount: Object.keys(metafile.inputs).length,
    packageInputCount: Object.keys(metafile.inputs).filter((path) => path.includes("node_modules/")).length,
    importKinds: Object.fromEntries(Object.entries(imports).sort(([left], [right]) => left.localeCompare(right))),
  };
}

const OXLINT_RULE_IDS: Readonly<Record<string, string>> = {
  "typescript(no-floating-promises)": "@typescript-eslint/no-floating-promises",
  "typescript(no-misused-promises)": "@typescript-eslint/no-misused-promises",
  "typescript(await-thenable)": "@typescript-eslint/await-thenable",
};

type OxlintSpan = { line: number; column: number };
type OxlintLabel = { span: OxlintSpan };
type OxlintDiagnostic = {
  message: string;
  code: string;
  severity: "error" | "warning" | "info";
  filename: string;
  labels: readonly OxlintLabel[];
  related: readonly OxlintDiagnostic[];
};

function invalidOxlintJson(message: string): never { throw new Error(`Invalid Oxlint diagnostic: ${message}`); }
function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidOxlintJson(`${context} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, context: string): string {
  if (typeof value !== "string") invalidOxlintJson(`${context} must be a string`);
  return value;
}
function position(value: unknown, context: string): OxlintSpan {
  const span = object(value, context);
  const line = span.line;
  const column = span.column;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1 || typeof column !== "number" || !Number.isInteger(column) || column < 1) invalidOxlintJson(`${context} must have positive line and column`);
  return { line, column };
}
function diagnostic(value: unknown, context: string): OxlintDiagnostic {
  const item = object(value, context);
  const severity = string(item.severity, `${context}.severity`);
  if (severity !== "error" && severity !== "warning" && severity !== "info") invalidOxlintJson(`${context}.severity is not supported`);
  if (!Array.isArray(item.labels) || item.labels.length === 0) invalidOxlintJson(`${context}.labels must be a non-empty array`);
  if (!Array.isArray(item.related)) invalidOxlintJson(`${context}.related must be an array`);
  return {
    message: string(item.message, `${context}.message`),
    code: string(item.code, `${context}.code`),
    severity,
    filename: string(item.filename, `${context}.filename`),
    labels: item.labels.map((label, index) => ({ span: position(object(label, `${context}.labels[${index}]`).span, `${context}.labels[${index}].span`) })),
    related: item.related.map((related, index) => diagnostic(related, `${context}.related[${index}]`)),
  };
}

function location(cwd: string, filename: string, label: OxlintLabel) {
  return { path: slash(relative(cwd, resolve(cwd, filename))), line: label.span.line, column: label.span.column };
}

/** Parse Oxlint's JSON reporter strictly, retaining all labeled source locations. */
export function parseOxlintJson(text: string, cwd: string): Finding[] {
  const report = object(JSON.parse(text), "Oxlint report");
  if (!Array.isArray(report.diagnostics)) invalidOxlintJson("Oxlint report.diagnostics must be an array");
  return report.diagnostics.map((value, index) => diagnostic(value, `Oxlint report.diagnostics[${index}]`)).flatMap((item) => {
    const ruleId = OXLINT_RULE_IDS[item.code];
    if (ruleId === undefined) return [];
    const labels = item.labels.map((label) => location(cwd, item.filename, label));
    const related = [...labels.slice(1), ...item.related.flatMap((diagnostic) => diagnostic.labels.map((label) => location(cwd, diagnostic.filename, label)))];
    return [{
      id: "",
      analyzer: AnalyzerName.Eslint,
      kind: FindingKind.Lint,
      severity: item.severity === "error" ? Severity.Error : item.severity === "warning" ? Severity.Warning : Severity.Info,
      message: `${ruleId}: ${item.message}`,
      location: labels[0]!,
      ...(related.length > 0 ? { related } : {}),
      data: { ruleId },
    }];
  });
}

/** @deprecated Oxlint replaced ESLint; retained for consumers of the analyzer module. */
export const parseEslintJson = parseOxlintJson;
