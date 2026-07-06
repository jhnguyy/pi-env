import type { SpawnSyncReturns } from "node:child_process";
import {
  type ActiveAgentEndResults,
  type AgentEndFileResult,
  formatAgentEndErrorResult,
  processAgentEndResults,
} from "./agent-end";
import { BackendMode, BackendName, getBackendConfig, type FormatBackendConfig } from "./backend-configs";
import {
  AgentEndBackendCheckKind,
  buildAgentEndReviewResult,
  type AgentEndBackendCheck,
  type AgentEndReviewMetadata,
} from "./agent-end-review";

export interface AgentEndFormatFile {
  file: string;
  config: FormatBackendConfig;
  bin?: string;
}

export interface AgentEndFilePartition {
  lspFiles: string[];
  formatFiles: AgentEndFormatFile[];
  skippedFiles: string[];
}

export interface AgentEndPipelineDeps {
  resolveFormatBinary: (name: string) => string | null;
  runFormat: (bin: string, args: string[]) => SpawnSyncReturns<string>;
}

export interface AgentEndPipelineResult {
  summary: string;
  triggerTurn: boolean;
  metadata: AgentEndReviewMetadata;
}

export function partitionAgentEndFiles(files: string[]): AgentEndFilePartition {
  const lspFiles: string[] = [];
  const formatFiles: AgentEndFormatFile[] = [];
  const skippedFiles: string[] = [];

  for (const file of files) {
    const config = getBackendConfig(file);
    if (!config) {
      skippedFiles.push(file);
      continue;
    }
    switch (config.mode) {
      case BackendMode.Lsp:
        lspFiles.push(file);
        break;
      case BackendMode.Format:
        formatFiles.push({ file, config });
        break;
    }
  }

  return { lspFiles, formatFiles, skippedFiles };
}

export function collectFormatAgentEndResults(
  formatFiles: AgentEndFormatFile[],
  deps: Pick<AgentEndPipelineDeps, "resolveFormatBinary" | "runFormat">,
): AgentEndFileResult[] {
  const results: AgentEndFileResult[] = [];

  for (const { file, config, bin: cachedBin } of formatFiles) {
    const bin = cachedBin ?? deps.resolveFormatBinary(config.binaryName);
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

export async function processAgentEndBatch(
  activeResults: ActiveAgentEndResults,
  files: string[],
  deps: AgentEndPipelineDeps,
): Promise<AgentEndPipelineResult> {
  const { lspFiles, formatFiles, skippedFiles } = partitionAgentEndFiles(files);
  const formatFilesWithBins = formatFiles.map((entry) => ({
    ...entry,
    bin: deps.resolveFormatBinary(entry.config.binaryName) ?? undefined,
  }));
  const runnableFormatFiles = formatFilesWithBins.filter((entry) => entry.bin);
  const unavailableFormatFiles = formatFilesWithBins
    .filter((entry) => !entry.bin)
    .map((entry) => entry.file);
  const results = [
    ...collectFormatAgentEndResults(runnableFormatFiles, deps),
  ];
  processAgentEndResults(activeResults, files, results);

  const backendChecks: AgentEndBackendCheck[] = [
    ...runnableFormatFiles.map((entry) => ({ kind: AgentEndBackendCheckKind.Format, backend: entry.config.name, files: [entry.file] })),
  ];

  return buildAgentEndReviewResult({
    checkedFiles: runnableFormatFiles.map((entry) => entry.file),
    skippedFiles: [...lspFiles, ...skippedFiles, ...unavailableFormatFiles],
    backendChecks,
    results,
  });
}
