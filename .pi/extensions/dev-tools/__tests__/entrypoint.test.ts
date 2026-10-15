import { describe, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { AgentToolEvent, PiEvent, ToolCapability } from "../../_shared/agent-tools";

describeIfEnabled("dev-tools", "extension entrypoint", () => {
  it("keeps read-only intelligence separate from write-capable agent edits", async () => {
    vi.resetModules();
    const sessionStartHandlers: Array<() => void> = [];
    const registrations: any[] = [];
    const piTools: any[] = [];
    const pi = {
      events: {
        emit(event: string, registration: unknown) {
          if (event === AgentToolEvent.Register) registrations.push(registration);
        },
      },
      registerCommand() {},
      registerTool(tool: any) {
        piTools.push(tool);
      },
      on(event: string, handler: () => void) {
        if (event === PiEvent.SessionStart) sessionStartHandlers.push(handler);
      },
    } as any;

    const { default: initDevTools } = await import("../index");
    initDevTools(pi);
    for (const handler of sessionStartHandlers) handler();

    const readRegistration = registrations.find(({ tool }) => tool.name === "dev-tools");
    const writeRegistration = registrations.find(({ tool }) => tool.name === "dev-tools-edit");
    const closeoutRegistration = registrations.find(({ tool }) => tool.name === "closeout");
    const closeoutPiTool = piTools.find(({ name }) => name === "closeout");
    expect(readRegistration.capabilities).toEqual([ToolCapability.Read]);
    expect(readRegistration.tool.parameters.properties.action.enum).not.toContain("rename");
    expect(writeRegistration.capabilities).toEqual([ToolCapability.Write]);
    expect(writeRegistration.tool.parameters.properties.action.enum).toEqual(["rename"]);
    expect(closeoutRegistration.capabilities).toEqual([
      ToolCapability.Write,
      ToolCapability.Execute,
    ]);
    expect(closeoutPiTool).toBeTruthy();
  });
});

// Daemon connection failures cannot be produced reliably by the live LSP E2E.
describe("dev-tools execution failures", () => {
  it("marks failures as errors in Pi and both child tool channels", async () => {
    const tools: any[] = [];
    const registrations: any[] = [];
    const starts: Array<() => void> = [];
    const { registerDevTools } = await import("../index");
    registerDevTools({
      registerCommand() {},
      registerTool: (tool: any) => tools.push(tool),
      on: (event: string, handler: () => void) => {
        if (event === PiEvent.SessionStart) starts.push(handler);
      },
      events: { emit: (event: string, data: any) => {
        if (event === AgentToolEvent.Register) registrations.push(data);
      } },
    } as any, { call: async () => { throw new Error("daemon unavailable"); } } as any);
    starts.forEach((start) => start());
    const channels = [tools.find((tool) => tool.name === "dev-tools"),
      ...registrations.flatMap(({ tool }) => tool.name.startsWith("dev-tools") ? [tool] : [])];
    expect(channels).toHaveLength(3);
    for (const tool of channels) {
      const result = await tool.execute("failure", {
        action: tool.name === "dev-tools-edit" ? "rename" : "hover",
        path: "/tmp/x.ts", line: 1, character: 1, newName: "renamed",
      });
      expect(result).toMatchObject({ isError: true, details: null });
      expect(result.content[0].text).toContain("daemon unavailable");
    }
  });
});
