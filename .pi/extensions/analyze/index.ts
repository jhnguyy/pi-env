import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { registerAgentToolsOnSessionStart, ToolCapability } from "../_shared/agent-tools";
import { runPublicAnalyze } from "../../../src/analyze/public";
import { AnalyzerName, ScopeMode, type AnalysisResult } from "../../../src/analyze/model";

const analyzerNames = Object.values(AnalyzerName);
const scopeNames = Object.values(ScopeMode);

export const analyzeToolSchema = Type.Object({
  worktree: Type.String({ description: "Absolute path to the worktree or project to analyze." }),
  scope: Type.Optional(StringEnum(scopeNames, { description: "Analysis scope. Safe local mode supports diff and non-empty explicit paths; all requires strict containment." })),
  paths: Type.Optional(Type.Array(Type.String(), { description: "Workspace-relative files or directories for paths scope." })),
  ref: Type.Optional(Type.String({ description: "Diff base ref. Defaults to main." })),
  checks: Type.Optional(Type.Array(StringEnum(analyzerNames), { description: "Checks must be explicit. Safe local mode permits complexity, async-risk, and scoped duplicates; other checks require strict containment." })),
  type_threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Structural type similarity threshold; requires strict containment." })),
  max_memory_mb: Type.Optional(Type.Integer({ minimum: 1, description: "Requested worker heap cap. Safe local mode always clamps to 512 MiB." })),
  profile: Type.Optional(Type.Boolean({ description: "Include timings and memory snapshots; requires strict containment." })),
  max_findings: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum findings returned. Defaults to 25." })),
});

export type AnalyzeToolInput = Static<typeof analyzeToolSchema>;
type AnalyzeRunner = (options: Parameters<typeof runPublicAnalyze>[0], signal?: AbortSignal) => Promise<AnalysisResult>;
interface AnalyzeToolDetails {
  summary: AnalysisResult["summary"];
  findings: AnalysisResult["findings"];
  analyzerFailures: AnalysisResult["analyzerFailures"];
  omittedFindings: number;
  profile?: AnalysisResult["profile"];
}

const runAnalysis: AnalyzeRunner = (options, signal) => runPublicAnalyze(options, { signal });

async function resolveWorktree(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("worktree must be an absolute path");
  const resolved = await realpath(path);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`worktree is not a directory: ${path}`);
  return resolved;
}

function compactResult(result: AnalysisResult, maxFindings: number): { text: string; details: AnalyzeToolDetails } {
  const findings = result.findings.slice(0, maxFindings);
  const omittedFindings = result.findings.length - findings.length;
  const lines = [
    `Summary: ${result.summary.error} errors, ${result.summary.warning} warnings, ${result.summary.info} info, ${result.summary.failures} failures`,
    ...findings.map((finding) =>
      `${finding.severity}\t${finding.analyzer}\t${finding.location.path}:${finding.location.line}:${finding.location.column}\t${finding.message.replaceAll("\n", " ")}`),
    ...result.analyzerFailures.map((failure) => `failure\t${failure.analyzer}\t${failure.message.replaceAll("\n", " ")}`),
  ];
  if (omittedFindings > 0) lines.push(`… ${omittedFindings} additional findings omitted.`);
  const truncated = truncateHead(lines.join("\n"), { maxBytes: 30_000, maxLines: 500 });
  const text = truncated.truncated ? `${truncated.content}\n… output truncated.` : truncated.content;
  return {
    text,
    details: { summary: result.summary, findings, analyzerFailures: result.analyzerFailures, omittedFindings, profile: result.profile },
  };
}

export function createAnalyzeTool(runner: AnalyzeRunner = runAnalysis): AgentTool<typeof analyzeToolSchema, AnalyzeToolDetails> {
  return {
    name: "analyze",
    label: "Analyze",
    description: "Run isolated, bounded code analysis. Local safe mode requires explicit complexity, async-risk, and/or scoped duplicates checks on diff or workspace-relative paths; semantic/external checks and all scope fail closed without strict containment.",
    parameters: analyzeToolSchema,
    execute: async (_toolCallId, params, signal) => {
      signal?.throwIfAborted();
      const cwd = await resolveWorktree(params.worktree);
      signal?.throwIfAborted();
      const scope = params.scope ?? ScopeMode.Diff;
      if (scope === ScopeMode.Paths && (!params.paths || params.paths.length === 0)) throw new Error("paths scope requires at least one path");
      const result = await runner({
        cwd,
        scope,
        paths: params.paths,
        ref: params.ref,
        checks: params.checks,
        maxMemoryMb: params.max_memory_mb,
        profile: params.profile,
        typeSimilarityThreshold: params.type_threshold,
      }, signal);
      const compact = compactResult(result, params.max_findings ?? 25);
      return { content: [{ type: "text", text: compact.text }], details: compact.details };
    },
  };
}

export default function (pi: ExtensionAPI) {
  const tool = createAnalyzeTool();
  pi.registerTool(tool);
  registerAgentToolsOnSessionStart(pi, { tool, capabilities: [ToolCapability.Read, ToolCapability.Execute] });
}
