import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { AgentToolEvent, PiEvent, ToolCapability, type ExtToolRegistration } from "../../_shared/agent-tools";
import linearExtension from "../index";

describe("Linear extension hosts", () => {
  it("publishes its read-only tool to Pi and AgentTool hosts", () => {
    const tools: ToolDefinition<any, any, any>[] = [];
    const registrations: ExtToolRegistration[] = [];
    let startSession: ((event: unknown, context: ExtensionContext) => void) | undefined;
    const pi = {
      registerTool: (tool: ToolDefinition<any, any, any>) => tools.push(tool),
      events: {
        emit(event: string, registration: ExtToolRegistration) {
          if (event === AgentToolEvent.Register) registrations.push(registration);
        },
      },
      on(event: string, handler: (event: unknown, context: ExtensionContext) => void) {
        if (event === PiEvent.SessionStart) startSession = handler;
      },
    };

    linearExtension(pi as any);

    expect(tools.map((tool) => tool.name)).toEqual(["linear"]);
    expect(registrations).toEqual([]);
    startSession?.({ type: PiEvent.SessionStart }, { cwd: "/repo" } as ExtensionContext);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      tool: { name: "linear" },
      capabilities: [ToolCapability.Read],
    });
  });
});
