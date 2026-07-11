import { relative } from "node:path";
import type { Metafile } from "esbuild";
import { AnalyzerName, FindingKind, Severity, type Finding } from "../model.js";

const slash = (value: string): string => value.replaceAll("\\", "/");

interface DependencyViolation {
  from?: string;
  to?: string;
  rule?: { name?: string; severity?: string };
  cycle?: readonly string[];
}

export function parseDependencyCruiserJson(text: string): Finding[] {
  const report = JSON.parse(text) as { summary?: { violations?: readonly DependencyViolation[] } };
  return (report.summary?.violations ?? []).map((violation) => {
    const from = slash(violation.from ?? violation.cycle?.[0] ?? ".");
    const target = violation.to ?? violation.cycle?.[1] ?? "unknown target";
    return {
      id: "",
      analyzer: AnalyzerName.Dependencies,
      kind: FindingKind.Dependency,
      severity: violation.rule?.severity === "error" ? Severity.Error : Severity.Warning,
      message: `${violation.rule?.name ?? "dependency violation"}: ${from} -> ${target}`,
      location: { path: from, line: 1, column: 1 },
      data: { rule: violation.rule?.name, target, cycle: violation.cycle },
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

interface EslintJsonResult {
  filePath: string;
  messages: readonly { ruleId: string | null; severity: number; message: string; line: number; column: number; endLine?: number; endColumn?: number }[];
}
const ESLINT_RULES = new Set(["@typescript-eslint/no-floating-promises", "@typescript-eslint/no-misused-promises", "@typescript-eslint/await-thenable"]);

export function parseEslintJson(text: string, cwd: string): Finding[] {
  const results = JSON.parse(text) as readonly EslintJsonResult[];
  return results.flatMap((result) => result.messages
    .filter((message) => message.ruleId !== null && ESLINT_RULES.has(message.ruleId))
    .map((message) => ({
      id: "",
      analyzer: AnalyzerName.Eslint,
      kind: FindingKind.Lint,
      severity: message.severity === 2 ? Severity.Error : Severity.Warning,
      message: `${message.ruleId}: ${message.message}`,
      location: { path: slash(relative(cwd, result.filePath)), line: message.line, column: message.column, endLine: message.endLine, endColumn: message.endColumn },
      data: { ruleId: message.ruleId },
    })));
}
