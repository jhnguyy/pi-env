import { Data } from "effect";

export const SubagentExecutionPhase = {
  Session: "session",
  AgentLoop: "agent_loop",
} as const;
export type SubagentExecutionPhase =
  typeof SubagentExecutionPhase[keyof typeof SubagentExecutionPhase];

/** Unexpected failures at the persistent-session or agent-loop boundary. */
export class SubagentExecutionError extends Data.TaggedError("SubagentExecutionError")<{
  readonly phase: SubagentExecutionPhase;
  readonly cause: unknown;
}> {}

/** The caller stopped waiting; the underlying asynchronous job continues. */
export class SubagentJobWaitInterrupted extends Data.TaggedError("SubagentJobWaitInterrupted")<{
  readonly jobId: string;
}> {}
