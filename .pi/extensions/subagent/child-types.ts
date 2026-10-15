import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SubagentDetails } from "./types";

export type NativeInputMode = "prompt" | "steer" | "followUp";
export interface NativeInputResult {
  outcome: "started" | "queued" | "handled";
}
export interface NativeChildInput {
  source: "coordinator" | "human";
  mode: NativeInputMode;
  text: string;
  at: string;
}
export interface NativeChildSnapshot {
  id: string;
  runId: string;
  name: string;
  task: string;
  cwd: string;
  sessionFile: string | undefined;
  model: string | undefined;
  systemPrompt: string;
  activeTools: string[];
  callableTools: string[];
  messages: readonly AgentMessage[];
  inputs: NativeChildInput[];
  state: "idle" | "running" | "queued" | "closing" | "closed";
  initialResult?: SubagentDetails;
}
export type NativeChildSummary = Pick<NativeChildSnapshot, "id" | "runId" | "name" | "task" | "cwd" | "sessionFile" | "model" | "state">;

export interface NativeChildSession {
  summary(): NativeChildSummary;
  readonly id: string;
  readonly runId: string;
  inspect(): NativeChildSnapshot;
  input(text: string, mode: NativeInputMode): Promise<NativeInputResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
