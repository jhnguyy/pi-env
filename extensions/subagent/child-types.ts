import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PromptOptions } from "@earendil-works/pi-coding-agent";
import type * as Types from "./types";

export type NativeInputMode = "prompt" | NonNullable<PromptOptions["streamingBehavior"]>;
export const NativeInputMode = {
  Prompt: "prompt",
  Steer: "steer",
  FollowUp: "followUp",
} as const satisfies Record<string, NativeInputMode>;
export type NativeInputOutcome = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];
export const NativeInputOutcome = {
  Started: "started",
  Queued: "queued",
  Handled: "handled",
} as const satisfies Record<string, NativeInputOutcome>;
export const InputProvenance = { Coordinator: "coordinator", Human: "human" } as const;
export type InputProvenance = (typeof InputProvenance)[keyof typeof InputProvenance];
export const NativeChildState = {
  Idle: "idle",
  Running: "running",
  Queued: "queued",
  Closing: "closing",
  Closed: "closed",
} as const;
export type NativeChildState = (typeof NativeChildState)[keyof typeof NativeChildState];

export interface NativeInputResult {
  outcome: NativeInputOutcome;
}
export interface NativeChildInput {
  // Persisted as `source`: authorship, distinct from Pi's input transport source.
  source: InputProvenance;
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
  availableInputs: readonly NativeInputMode[];
  initialResult?: Types.SubagentDetails;
}
export type NativeChildSummary = Pick<
  NativeChildSnapshot,
  "id" | "runId" | "name" | "task" | "cwd" | "sessionFile" | "model" | "state"
>;

export interface NativeChildSession {
  summary(): NativeChildSummary;
  checkpointUsage(): void;
  readonly id: string;
  readonly runId: string;
  inspect(): NativeChildSnapshot;
  input(text: string, mode: NativeInputMode): Promise<NativeInputResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
