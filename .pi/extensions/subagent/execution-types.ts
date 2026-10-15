import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpanExporter } from "@opentelemetry/sdk-trace-node";
import type * as Tooling from "../../../src/telemetry/tooling";
import type * as Config from "./config";
import type * as Control from "./control";
import type * as Types from "./types";
import type * as Usage from "./usage";
import type * as ChildTypes from "./child-types";

export type SubagentParentContext = Pick<ExtensionContext, "cwd" | "sessionManager" | "isProjectTrusted">;

export interface RunSubagentOptions {
  onUpdate?: AgentToolUpdateCallback<Types.SubagentDetails>;
  onUsage?: (details: Types.SubagentDetails) => void;
  signal?: AbortSignal;
  ledger?: Usage.SubagentUsageLedger;
  runId?: string;
  env?: Readonly<Record<string, string | undefined>>;
  telemetryExporter?: SpanExporter;
  telemetryRuntime?: Tooling.ToolingTelemetryRuntime;
  executionMode?: Usage.SubagentUsageMode;
  supervisor?: Control.SubagentRunSupervisor;
  workspaceAccess?: Control.WorkspaceAccess;
  sessionStorage?: Config.SubagentSessionStorage;
  onAdmitted?: () => void;
  /** Retention only: the child owns all native execution. */
  onChild?: (child: ChildTypes.NativeChildSession) => void;
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
  workspaceAccess?: Control.WorkspaceAccess;
}
