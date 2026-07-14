import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { defineTool, type ExtensionAPI, type ToolDefinition, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerAgentTools, resetAgentToolRegistryForTests, ToolCapability } from "../../_shared/agent-tools";
import { registerPtcTools, resetPtcToolRegistryForTests } from "../../_shared/ptc-tools";
import toolManager from "../../tool-manager";
import { ToolRegistry } from "../tool-registry";

function eventBus() {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  const emitted: { event: string; data: unknown }[] = [];
  return {
    emitted,
    events: {
      emit(event: string, data: unknown) {
        emitted.push({ event, data });
        for (const listener of listeners.get(event) ?? []) listener(data);
      },
      on(event: string, handler: (data: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), handler]);
        return () => {};
      },
    },
  };
}

function sourceInfo(source: "builtin" | "extension") {
  return { source, path: `/test/${source}`, scope: "project", origin: "top-level" } as const;
}

function createHarness(activeNames: string[]) {
  const bus = eventBus();
  const active = [...activeNames];
  const tools: ToolInfo[] = [
    { name: "read", description: "read", parameters: {}, sourceInfo: sourceInfo("builtin") as ToolInfo["sourceInfo"] },
  ];
  const appended: Array<{ type: string; data: unknown }> = [];

  const createApi = (): ExtensionAPI => ({
    registerTool(tool: ToolDefinition<any, any, any>) {
      tools.push({ ...tool, sourceInfo: sourceInfo("extension") as ToolInfo["sourceInfo"] });
    },
    registerCommand() {},
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => active.splice(0, active.length, ...next),
    getAllTools: () => tools,
    on() {},
    events: bus.events,
  } as unknown as ExtensionAPI);

  return { api: createApi(), createApi, tools, bus, active, appended };
}

const externalTool: ToolDefinition<any, any, any> = defineTool({
  name: "external",
  label: "external",
  description: "external",
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
});

describe("ToolRegistry active filtering", () => {
  beforeEach(() => {
    resetAgentToolRegistryForTests();
    resetPtcToolRegistryForTests();
  });

  it("excludes inactive tools from ptc availability and dispatch", async () => {
    const harness = createHarness([]);
    registerPtcTools(harness.api, externalTool);
    const registry = new ToolRegistry(harness.api);

    expect(registry.getAvailableTools(harness.api).map((tool) => tool.name)).toEqual([]);
    await expect(registry.dispatch("read", {}, process.cwd(), undefined)).rejects.toThrow("inactive");
    await expect(registry.dispatch("external", {}, process.cwd(), undefined)).rejects.toThrow("inactive");
  });

  test.each([
    ["before", (register: () => void, _registry: () => ToolRegistry) => register()],
    ["after", (register: () => void, registry: () => ToolRegistry) => { registry(); register(); }],
  ] as const)("%s-construction PTC registrations are available", async (_label, arrange) => {
    const harness = createHarness(["external"]);
    let registry: ToolRegistry | undefined;
    const getRegistry = () => (registry ??= new ToolRegistry(harness.createApi()));

    arrange(() => registerPtcTools(harness.createApi(), externalTool), getRegistry);

    expect(getRegistry().getAvailableTools(harness.api).map((tool) => tool.name)).toContain("external");
    await expect(getRegistry().dispatch("external", {}, process.cwd(), undefined)).resolves.toBe("ok");
  });

  it("executes agent-tool registrations through the four-argument subagent seam", async () => {
    const harness = createHarness(["external"]);
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "agent ok" }], details: {} }));
    const registry = new ToolRegistry(harness.api);

    registerAgentTools(harness.createApi(), {
      tool: { name: "external", label: "external", description: "external", parameters: Type.Object({}), execute },
      capabilities: [ToolCapability.Read],
    });

    await expect(registry.dispatch("external", {}, process.cwd(), undefined, { cwd: process.cwd() })).resolves.toBe("agent ok");
    expect(execute.mock.calls[0]).toHaveLength(4);
  });

  it("dispatches real search_tools from a distinct extension API without agent-channel emission", async () => {
    const harness = createHarness(["search_tools"]);
    harness.tools.push(
      { name: "web_fetch", description: "web", parameters: {}, sourceInfo: sourceInfo("extension") as ToolInfo["sourceInfo"] },
      { name: "web_context", description: "web", parameters: {}, sourceInfo: sourceInfo("extension") as ToolInfo["sourceInfo"] },
    );

    const ptcApi = harness.createApi();
    const managerApi = harness.createApi();
    const originalRegisterTool = managerApi.registerTool;
    const registry = new ToolRegistry(ptcApi);
    toolManager(managerApi);

    expect(ptcApi.registerTool).not.toBe(managerApi.registerTool);
    expect(managerApi.registerTool).toBe(originalRegisterTool);
    expect(registry.getAvailableTools(ptcApi).map((tool) => tool.name)).toContain("search_tools");

    const result = await registry.dispatch("search_tools", { query: "web" }, process.cwd(), undefined);
    expect(result).toContain("loaded:");
    expect(result).toContain("web_fetch");
    expect(result).toContain("web_context");
    expect(harness.active).toEqual(expect.arrayContaining(["search_tools", "web_fetch", "web_context"]));
    expect(harness.appended).toEqual([
      { type: "tool-manager:state", data: expect.objectContaining({ reason: "search" }) },
    ]);
    expect(harness.bus.emitted.filter((event) => event.event === "agent-tools:register")).toEqual([]);
  });
});
