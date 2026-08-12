import { beforeEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  AgentToolEvent,
  PiEvent,
  ToolCapability,
  listenForAgentTools,
  registerAgentTools,
  registerAgentToolsOnSessionStart,
  unregisterAgentTools,
  type AgentToolEvent as AgentToolEventValue,
  type AgentToolEvents,
  type ExtToolRegistration,
} from "../_shared/agent-tools";
import { resetAgentToolRegistryForTests } from "../_shared/agent-tools";

function createPi(): AgentToolEvents & { trigger(event: string): void } {
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const lifecycleHandlers = new Map<string, Array<() => void>>();
  return {
    events: {
      emit(event: AgentToolEventValue, data: ExtToolRegistration) {
        for (const handler of eventHandlers.get(event) ?? []) handler(data);
      },
      on(event: AgentToolEventValue, handler: (data: unknown) => void) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
        return () => {
          const index = handlers.indexOf(handler);
          if (index >= 0) handlers.splice(index, 1);
        };
      },
    },
    on(event: typeof PiEvent.SessionStart, handler: () => void) {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
    trigger(event: string) {
      for (const handler of lifecycleHandlers.get(event) ?? []) handler();
    },
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

  it("does not replay a revoked registration after its listener stops", () => {
    const pi = createPi();
    const [registration] = registerAgentTools(pi, {
      tool: tool("revoked"),
      capabilities: [ToolCapability.Read],
    });
    const stop = listenForAgentTools(pi, () => {});
    stop();

    unregisterAgentTools(pi, [registration!]);
    const replayed: string[] = [];
    listenForAgentTools(pi, (entry) => replayed.push(entry.tool.name));
    expect(replayed).toEqual([]);
  });

  it("creates session-bound factories and revokes them at shutdown", () => {
    const pi = createPi();
    const added: ExtToolRegistration[] = [];
    const removed: ExtToolRegistration[] = [];
    listenForAgentTools(pi, (registration) => added.push(registration), (registration) => removed.push(registration));
    registerAgentToolsOnSessionStart(pi, {
      tool: tool("scoped"),
      createTool: ({ cwd, sessionGeneration }) => tool(`${cwd}:${sessionGeneration}`),
      capabilities: [ToolCapability.Read],
    });

    pi.trigger(PiEvent.SessionStart);
    expect(added).toHaveLength(1);
    const registration = added[0]!;
    const child = registration.createTool?.({
      cwd: "/child",
      sessionGeneration: registration.sessionGeneration!,
    });
    expect(child?.name).toBe(`/child:${registration.sessionGeneration}`);

    pi.trigger(PiEvent.SessionShutdown);
    expect(removed).toEqual([registration]);
    const replayed: string[] = [];
    listenForAgentTools(pi, (entry) => replayed.push(entry.tool.name));
    expect(replayed).toEqual([]);
  });
});
