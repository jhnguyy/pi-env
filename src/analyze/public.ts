import { classifyAnalyzeRequest, type PublicAnalyzeRequest } from "./policy.js";
import { superviseAnalyze, type SupervisorOptions } from "./supervisor.js";
import type { AnalysisResult, AnalyzerFailure } from "./model.js";

function refusal(analyzer: AnalyzerFailure["analyzer"], message: string): AnalysisResult {
  return {
    version: 1,
    summary: { info: 0, warning: 0, error: 0, failures: 1 },
    findings: [],
    analyzerFailures: [{ analyzer, message: message.slice(0, 1_024) }],
    benchmarks: [],
  };
}

export async function runPublicAnalyze(
  request: PublicAnalyzeRequest,
  options: SupervisorOptions = {},
): Promise<AnalysisResult> {
  const policy = classifyAnalyzeRequest(request);
  if (policy._tag === "invalid") return refusal("configuration", policy.reason);
  if (policy._tag === "strict") {
    return refusal("containment", `strict containment required but unavailable: ${policy.reason}`);
  }
  try {
    return await superviseAnalyze(policy.request, options);
  } catch (cause) {
    return refusal(
      "supervisor",
      cause instanceof Error ? cause.message : "analyze supervisor failed",
    );
  }
}
