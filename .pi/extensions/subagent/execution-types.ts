import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { ToolingTelemetryRuntime } from "../../../src/telemetry/tooling";
import type { SubagentSessionStorage as SubagentSessionStorageValue } from "./config";
import type { SubagentRunSupervisor, WorkspaceAccess as WorkspaceAccessValue } from "./control";
import type { SubagentDetails } from "./types";
import type { SubagentUsageMode, SubagentUsageLedger } from "./usage";
import type { NativeChildSession } from "./child-types";

export type SubagentParentContext = Pick<ExtensionContext, "cwd" | "sessionManager" | "isProjectTrusted">;

export interface RunSubagentOptions {
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>;
  onUsage?: (details: SubagentDetails) => void;
  signal?: AbortSignal;
  ledger?: SubagentUsageLedger;
  runId?: string;
  env?: Readonly<Record<string, string | undefined>>;
  telemetryExporter?: SpanExporter;
  telemetryRuntime?: ToolingTelemetryRuntime;
  executionMode?: SubagentUsageMode;
  supervisor?: SubagentRunSupervisor;
  workspaceAccess?: WorkspaceAccessValue;
  sessionStorage?: SubagentSessionStorageValue;
  onAdmitted?: () => void;
  /** Retention only: the child owns all native execution. */
  onChild?: (child: NativeChildSession) => void;
}

export interface ResolvedSubagentRun {
  name: string;
  task: string;
  cwd: string;
  modelOverride?: string;
  systemPrompt?: string;
  toolNames?: readonly string[];
  customTools?: readonly ToolDefinition[];
  reasoning?: ThinkingLevel;
  maxTurns?: number;
  workspaceAccess?: WorkspaceAccessValue;
}
