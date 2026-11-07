export const PiEvent = {
  SessionStart: "session_start",
  SessionShutdown: "session_shutdown",
  SessionBeforeTree: "session_before_tree",
  BeforeAgentStart: "before_agent_start",
  BeforeProviderRequest: "before_provider_request",
  TurnEnd: "turn_end",
  Context: "context",
  ToolResult: "tool_result",
  AgentEnd: "agent_end",
  AgentSettled: "agent_settled",
} as const;
export type PiEvent = (typeof PiEvent)[keyof typeof PiEvent];

export const ToolCapability = {
  Read: "read",
  Write: "write",
  Execute: "execute",
} as const;
export type ToolCapability = (typeof ToolCapability)[keyof typeof ToolCapability];
