import { describe, expect, it, beforeEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  AgentToolEvent,
  PiEvent,
  ToolCapability,
  listenForAgentTools,
  registerAgentTools,
  type AgentToolEvents,
  type ExtToolRegistration,
} from "../_shared/agent-tools";
import { resetAgentToolRegistryForTests } from "../_shared/agent-tools";

function createPi(): AgentToolEvents {
  const handlers: Array<(data: unknown) => void> = [];
  return {
    events: {
      emit(event: typeof AgentToolEvent.Register, data: ExtToolRegistration) {
        if (event === AgentToolEvent.Register) for (const handler of handlers) handler(data);
      },
      on(event: typeof AgentToolEvent.Register, handler: (data: unknown) => void) {
        if (event === AgentToolEvent.Register) handlers.push(handler);
      },
    },
    on(_event: typeof PiEvent.SessionStart, _handler: () => void) {},
  };
}

function tool(name: string): AgentTool<any, any> {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as any,
    execute: async () => ({ content: [{ type: "text", text: name }], details: null }),
  };
}

describe("agent tool registration", () => {
  beforeEach(() => {
    resetAgentToolRegistryForTests();
  });

  it("replays registrations to late listeners", () => {
    const pi = createPi();
    registerAgentTools(pi, { tool: tool("early"), capabilities: [ToolCapability.Read] });

    const names: string[] = [];
    listenForAgentTools(pi, (registration) => names.push(registration.tool.name));

    expect(names).toEqual(["early"]);
  });

  it("delivers later event registrations once through the event bus", () => {
    const pi = createPi();
    const names: string[] = [];
    listenForAgentTools(pi, (registration) => names.push(registration.tool.name));

    registerAgentTools(pi, { tool: tool("later"), capabilities: [ToolCapability.Write] });

    expect(names).toEqual(["later"]);
  });

  it("replaces registrations by tool name for late listeners", () => {
    const pi = createPi();
    registerAgentTools(pi, { tool: tool("same"), capabilities: [ToolCapability.Read] });
    registerAgentTools(pi, { tool: tool("same"), capabilities: [ToolCapability.Write] });

    const capabilities: ToolCapability[][] = [];
    listenForAgentTools(pi, (registration) => capabilities.push(registration.capabilities));

    expect(capabilities).toEqual([[ToolCapability.Write]]);
  });
});
