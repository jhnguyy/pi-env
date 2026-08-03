import { describe, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { AgentToolEvent, PiEvent, ToolCapability } from "../../_shared/agent-tools";

describeIfEnabled("dev-tools", "extension entrypoint", () => {
  it("registers action formatters and renderers when the tool bundle loads", async () => {
    vi.resetModules();

    await import("../index");
    const { getAction } = await import("../action-registry");

    expect(getAction("diagnostics")).toBeDefined();
    expect(getAction("hover")).toBeDefined();
  });

  it("maps code-navigation intents to actions in the active tool guidance", async () => {
    vi.resetModules();
    const tools: any[] = [];
    const pi = {
      registerCommand() {},
      registerTool(tool: any) {
        tools.push(tool);
      },
      on() {},
    } as any;

    const { default: initDevTools } = await import("../index");
    initDevTools(pi);

    const guidance = tools.find((tool) => tool.name === "dev-tools").promptGuidelines.join("\n");
    expect(guidance).toContain("dev-tools symbols to orient");
    expect(guidance).toContain("dev-tools definition to locate declarations");
    expect(guidance).toContain("dev-tools rename to rename symbols across supported files");
    expect(guidance).toContain("dev-tools incoming-calls before changing a callable signature");
    expect(guidance).toContain("outgoing-calls to map dependencies before refactoring");
    expect(guidance).toContain("dev-tools diagnostics to validate changed code");
    expect(guidance).toContain("Use rg only for text or pattern searches");
  });

  it("keeps read-only intelligence separate from write-capable agent edits", async () => {
    vi.resetModules();
    const sessionStartHandlers: Array<() => void> = [];
    const registrations: any[] = [];
    const pi = {
      events: {
        emit(event: string, registration: unknown) {
          if (event === AgentToolEvent.Register) registrations.push(registration);
        },
      },
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: () => void) {
        if (event === PiEvent.SessionStart) sessionStartHandlers.push(handler);
      },
    } as any;

    const { default: initDevTools } = await import("../index");
    initDevTools(pi);
    for (const handler of sessionStartHandlers) handler();

    const readRegistration = registrations.find(({ tool }) => tool.name === "dev-tools");
    const writeRegistration = registrations.find(({ tool }) => tool.name === "dev-tools-edit");
    expect(readRegistration.capabilities).toEqual([ToolCapability.Read]);
    expect(readRegistration.tool.parameters.properties.action.enum).not.toContain("rename");
    expect(writeRegistration.capabilities).toEqual([ToolCapability.Write]);
    expect(writeRegistration.tool.parameters.properties.action.enum).toEqual(["rename"]);
  });
});
