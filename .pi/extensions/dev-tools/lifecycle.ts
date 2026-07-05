import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type ActiveAgentEndResults,
  type AgentEndFileResult,
  renderActiveAgentEndSummary,
} from "./agent-end";
import { processAgentEndBatch } from "./agent-end-pipeline";
import type { LspResult } from "./protocol";
import { PendingPostEditFiles, type ToolResultEditEvent } from "./post-edit-files";
import { PiEvent } from "../_shared/agent-tools";

export interface DevToolsLifecycleDeps {
  runDiagnostics: (paths: string[]) => Promise<LspResult | null>;
  runCodeSensors?: (cwd: string, paths: string[]) => Promise<AgentEndFileResult[]>;
  resolveFormatBinary?: (name: string) => string | null;
  runFormat?: (bin: string, args: string[]) => SpawnSyncReturns<string>;
  defer?: (callback: () => void) => void;
}

export interface DevToolsLifecycleState {
  pendingFiles: PendingPostEditFiles;
  activeAgentEndResults: ActiveAgentEndResults;
}

// Resolved lazily on first agent_end that contains format-backend files.
// Keyed by binary name so any number of format backends share the same cache.
const binCache = new Map<string, string | null>();

export function resolveFormatBinary(name: string): string | null {
  if (binCache.has(name)) return binCache.get(name)!;
  const r = spawnSync("which", [name], { encoding: "utf8", stdio: "pipe" });
  const result = r.status === 0 ? r.stdout.trim() || null : null;
  binCache.set(name, result);
  return result;
}

export function createDevToolsLifecycleState(): DevToolsLifecycleState {
  return {
    pendingFiles: new PendingPostEditFiles(),
    activeAgentEndResults: new Map<string, AgentEndFileResult>(),
  };
}

export function registerDevToolsLifecycle(
  pi: ExtensionAPI,
  deps: DevToolsLifecycleDeps,
  state: DevToolsLifecycleState = createDevToolsLifecycleState(),
): DevToolsLifecycleState {
  const resolveBinary = deps.resolveFormatBinary ?? resolveFormatBinary;
  const runFormat = deps.runFormat ?? ((bin, args) => spawnSync(bin, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10_000,
  }));
  const defer = deps.defer ?? ((callback) => setTimeout(callback, 0));

  pi.on(PiEvent.SessionStart, () => {
    state.pendingFiles.clear();
    state.activeAgentEndResults.clear();
  });

  pi.on(PiEvent.Context, async (event) => {
    const messages = event.messages.filter((message) => {
      const customType = (message as { customType?: string }).customType;
      return customType !== "dev-tools-agent-end";
    });
    const summary = renderActiveAgentEndSummary(state.activeAgentEndResults);
    if (summary) {
      messages.push({
        role: "custom",
        customType: "dev-tools-agent-end",
        content: `[post-edit]\n${summary}`,
        display: false,
        timestamp: Date.now(),
      });
    }
    return { messages };
  });

  pi.on(PiEvent.ToolResult, async (event) => {
    state.pendingFiles.recordToolResult(event as ToolResultEditEvent);
  });

  pi.on(PiEvent.AgentEnd, async (_event, ctx) => {
    const files = state.pendingFiles.drain();
    if (files.length === 0) return;

    const processed = await processAgentEndBatch(state.activeAgentEndResults, files, {
      resolveFormatBinary: resolveBinary,
      runFormat,
      runDiagnostics: deps.runDiagnostics,
      runCodeSensors: deps.runCodeSensors ? (paths) => deps.runCodeSensors?.(ctx?.cwd ?? process.cwd(), paths) ?? Promise.resolve([]) : undefined,
    });

    if (!processed.summary) return;

    const message = {
      customType: "dev-tools-agent-end",
      content: `[post-edit]\n${processed.summary}`,
      display: true,
    };

    defer(() => {
      void pi.sendMessage(
        message,
        processed.triggerTurn ? { triggerTurn: true, deliverAs: "followUp" } : undefined,
      );
    });
  });

  return state;
}
