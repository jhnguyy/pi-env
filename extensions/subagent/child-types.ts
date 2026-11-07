import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type * as Types from "./types";

export const NativeInputMode = { Prompt: "prompt", Steer: "steer", FollowUp: "followUp" } as const;
export type NativeInputMode = typeof NativeInputMode[keyof typeof NativeInputMode];
export const NativeInputOutcome = { Started: "started", Queued: "queued", Handled: "handled" } as const;
export type NativeInputOutcome = typeof NativeInputOutcome[keyof typeof NativeInputOutcome];
export const NativeInputSource = { Coordinator: "coordinator", Human: "human" } as const;
export type NativeInputSource = typeof NativeInputSource[keyof typeof NativeInputSource];
export const NativeChildState = { Idle: "idle", Running: "running", Queued: "queued", Closing: "closing", Closed: "closed" } as const;
export type NativeChildState = typeof NativeChildState[keyof typeof NativeChildState];

export interface NativeInputResult {
  outcome: NativeInputOutcome;
}
export interface NativeChildInput {
  source: NativeInputSource;
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
  state: NativeChildState;
  initialResult?: Types.SubagentDetails;
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
