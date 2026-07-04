import type { SpawnSyncReturns } from "node:child_process";
import {
  type ActiveAgentEndResults,
  type AgentEndFileResult,
  diagnosticsToAgentEndResults,
  formatAgentEndErrorResult,
  processAgentEndResults,
} from "./agent-end";
import { BackendMode, getBackendConfig, type FormatBackendConfig } from "./backend-configs";
import type { LspResult } from "./protocol";

export interface AgentEndFormatFile {
  file: string;
  config: FormatBackendConfig;
}

export interface AgentEndFilePartition {
  lspFiles: string[];
  formatFiles: AgentEndFormatFile[];
}

export interface AgentEndPipelineDeps {
  resolveFormatBinary: (name: string) => string | null;
  runFormat: (bin: string, args: string[]) => SpawnSyncReturns<string>;
  runDiagnostics: (paths: string[]) => Promise<LspResult | null>;
}

export interface AgentEndPipelineResult {
  summary: string;
  triggerTurn: boolean;
}

export function partitionAgentEndFiles(files: string[]): AgentEndFilePartition {
  const lspFiles: string[] = [];
  const formatFiles: AgentEndFormatFile[] = [];

  for (const file of files) {
    const config = getBackendConfig(file);
    if (!config) continue;
    if (config.mode === BackendMode.Lsp) lspFiles.push(file);
    else formatFiles.push({ file, config });
  }

  return { lspFiles, formatFiles };
}

export function collectFormatAgentEndResults(
  formatFiles: AgentEndFormatFile[],
  deps: Pick<AgentEndPipelineDeps, "resolveFormatBinary" | "runFormat">,
): AgentEndFileResult[] {
  const results: AgentEndFileResult[] = [];

  for (const { file, config } of formatFiles) {
    const bin = deps.resolveFormatBinary(config.binaryName);
    if (!bin) continue;
    try {
      const r = deps.runFormat(bin, config.formatArgs(file));
      if (r.status !== 0) {
        const detail = r.stderr.trim() || `exit ${r.status}`;
        results.push(formatAgentEndErrorResult(config.name, file, detail));
      }
    } catch (e) {
      results.push(formatAgentEndErrorResult(
        config.name,
        file,
        e instanceof Error ? e.message : String(e),
      ));
    }
  }

  return results;
}

export async function collectDiagnosticsAgentEndResults(
  lspFiles: string[],
  runDiagnostics: AgentEndPipelineDeps["runDiagnostics"],
): Promise<AgentEndFileResult[]> {
  if (lspFiles.length === 0) return [];

  try {
    const result = await runDiagnostics(lspFiles);
    return result?.action === "diagnostics" ? diagnosticsToAgentEndResults(result) : [];
  } catch {
    // Non-fatal — diagnostics are best-effort.
    return [];
  }
}

export async function processAgentEndBatch(
  activeResults: ActiveAgentEndResults,
  files: string[],
  deps: AgentEndPipelineDeps,
): Promise<AgentEndPipelineResult> {
  const { lspFiles, formatFiles } = partitionAgentEndFiles(files);
  const results = [
    ...collectFormatAgentEndResults(formatFiles, deps),
    ...await collectDiagnosticsAgentEndResults(lspFiles, deps.runDiagnostics),
  ];
  const processed = processAgentEndResults(activeResults, files, results);

  return {
    summary: processed.batchSummary,
    triggerTurn: processed.triggerTurn,
  };
}
