import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type * as Tooling from "../../../src/telemetry/tooling";
import type * as Config from "./config";
import type * as Control from "./control";
import type * as Types from "./types";
import type * as Usage from "./usage";
import type { SubagentServiceConnection } from "./service-host";
import type { ReviewCapability } from "../../../src/subagent-service/review-capability";

export type SubagentParentContext = Pick<ExtensionContext, "cwd" | "sessionManager" | "isProjectTrusted">;

export interface RunSubagentOptions {
  onUpdate?: AgentToolUpdateCallback<Types.SubagentDetails>;
  onUsage?: (details: Types.SubagentDetails) => void;
  signal?: AbortSignal;
  ledger?: Usage.SubagentUsageLedger;
  runId?: string;
  requestId?: string;
  env?: Readonly<Record<string, string | undefined>>;
  telemetryExporter?: SpanExporter;
  telemetryRuntime?: Tooling.ToolingTelemetryRuntime;
  executionMode?: Usage.SubagentUsageMode;
  serviceConnection?: SubagentServiceConnection;
  admission?: { scopeId: string; limits: Config.SubagentRuntimeConfig };
  workspaceAccess?: Control.WorkspaceAccess;
  onAdmitted?: () => void;
}

export interface ResolvedSubagentRun {
  name: string;
  task: string;
  cwd: string;
  modelOverride?: string;
  systemPrompt?: string;
  toolNames?: readonly string[];
  customTools?: readonly ToolDefinition[];
  reviewCapability?: ReviewCapability;
  reasoning?: ThinkingLevel;
  maxTurns?: number;
  workspaceAccess?: Control.WorkspaceAccess;
}
