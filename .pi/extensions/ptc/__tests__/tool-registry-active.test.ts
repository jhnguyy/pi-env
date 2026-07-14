import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineTool, type ExtensionAPI, type ToolDefinition, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resetAgentToolRegistryForTests } from "../../_shared/agent-tool-registry";
import { registerAgentTools, ToolCapability } from "../../_shared/agent-tools";
import { resetPtcToolRegistryForTests } from "../../_shared/ptc-tool-registry";
import { registerPtcTools } from "../../_shared/ptc-tools";
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
      },
    },
  };
}

function sourceInfo(source: "builtin" | "extension") {
  return { source, path: `/test/${source}`, scope: "project", origin: "top-level" } as const;
}

function createHarness(activeNames: string[], bus = eventBus()) {
  const active = [...activeNames];
  const tools: ToolInfo[] = [
    { name: "read", description: "read", parameters: {}, sourceInfo: sourceInfo("builtin") as ToolInfo["sourceInfo"] },
    { name: "external", description: "external", parameters: {}, sourceInfo: sourceInfo("extension") as ToolInfo["sourceInfo"] },
  ];
  const appended: Array<{ type: string; data: unknown }> = [];

  const createApi = (): ExtensionAPI => ({
    registerTool(tool: ToolDefinition<any, any, any>) {
      tools.push({ ...tool, sourceInfo: sourceInfo("extension") as ToolInfo["sourceInfo"] });
    },
    registerCommand() {},
    appendEntry(type: string, data: unknown) {
      appended.push({ type, data });
    },
    getActiveTools: () => active,
    setActiveTools(next: string[]) {
      active.splice(0, active.length, ...next);
    },
    getAllTools: () => tools,
    on() {},
    events: {
      emit: bus.events.emit,
      on(event: string, handler: (data: unknown) => void) {
        bus.events.on(event, handler);
        return () => {};
      },
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag() { return undefined; },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    setSessionName() {},
    getSessionName() { return undefined; },
    setLabel() {},
    exec: vi.fn(),
    getCommands() { return []; },
    setModel: async () => false,
    getThinkingLevel: () => "minimal" as any,
    setThinkingLevel() {},
    registerProvider() {},
    unregisterProvider() {},
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

  it("excludes inactive tools from ptc availability", () => {
    const stub = createHarness(["read"]);
    const registry = new ToolRegistry(stub.api);
    expect(registry.getAvailableTools(stub.api).map((tool) => tool.name)).toEqual(["read"]);
  });

  it("rejects direct dispatch of inactive tools before execution", async () => {
    const stub = createHarness([]);
    const registry = new ToolRegistry(stub.api);
    await expect(registry.dispatch("read", {}, process.cwd(), undefined)).rejects.toThrow("inactive");
  });

  it("replays PTC-only tools registered before registry construction", async () => {
    const harness = createHarness(["external"]);
    const extensionApi = harness.createApi();
    const ptcApi = harness.createApi();
    registerPtcTools(extensionApi, externalTool);

    const registry = new ToolRegistry(ptcApi);
    expect(registry.getAvailableTools(ptcApi).map((tool) => tool.name)).toContain("external");
    await expect(registry.dispatch("external", {}, process.cwd(), undefined)).resolves.toBe("ok");
  });

  it("receives PTC-only tools registered after registry construction", async () => {
    const harness = createHarness(["external"]);
    const extensionApi = harness.createApi();
    const ptcApi = harness.createApi();
    const registry = new ToolRegistry(ptcApi);

    registerPtcTools(extensionApi, externalTool);
    await expect(registry.dispatch("external", {}, process.cwd(), undefined)).resolves.toBe("ok");
  });

  it("does not pass PTC context through the subagent registration channel", async () => {
    const harness = createHarness(["external"]);
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "agent ok" }], details: {} }));
    const registry = new ToolRegistry(harness.api);
    registerAgentTools(harness.createApi(), {
      tool: {
        name: "external",
        label: "external",
        description: "external",
        parameters: Type.Object({}),
        execute,
      },
      capabilities: [ToolCapability.Read],
    });

    await expect(registry.dispatch("external", {}, process.cwd(), undefined, { cwd: process.cwd() })).resolves.toBe("agent ok");
    expect(execute.mock.calls[0]).toHaveLength(4);
  });

  it("does not monkey-patch registerTool", () => {
    const stub = createHarness(["external"]);
    const original = stub.api.registerTool;
    new ToolRegistry(stub.api);
    expect(stub.api.registerTool).toBe(original);
  });

  it("dispatches real search_tools registered from a distinct extension API", async () => {
    const harness = createHarness(["search_tools"]);
    harness.tools.push(
      { name: "web_fetch", description: "web", parameters: {}, sourceInfo: sourceInfo("extension") as ToolInfo["sourceInfo"] },
      { name: "web_context", description: "web", parameters: {}, sourceInfo: sourceInfo("extension") as ToolInfo["sourceInfo"] },
    );

    const ptcApi = harness.createApi();
    const managerApi = harness.createApi();
    expect(ptcApi.registerTool).not.toBe(managerApi.registerTool);
    const originalRegisterTool = managerApi.registerTool;
    const registry = new ToolRegistry(ptcApi);
    toolManager(managerApi);
    expect(managerApi.registerTool).toBe(originalRegisterTool);
    expect(registry.getAvailableTools(ptcApi).map((tool) => tool.name)).toContain("search_tools");

    const result = await registry.dispatch("search_tools", { query: "web" }, process.cwd(), undefined);
    expect(result).toContain("loaded:");
    expect(result).toContain("web_fetch");
    expect(result).toContain("web_context");
    expect(harness.active).toEqual(expect.arrayContaining(["search_tools", "web_fetch", "web_context"]));
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]).toMatchObject({ type: "tool-manager:state", data: expect.objectContaining({ reason: "search" }) });
    expect(harness.bus.emitted.filter((event) => event.event === "agent-tools:register")).toEqual([]);
  });

  it("rejects inactive PTC-only extension dispatch", async () => {
    const stub = createHarness([], eventBus());
    registerPtcTools(stub.api, externalTool);
    const registry = new ToolRegistry(stub.api);
    await expect(registry.dispatch("external", {}, process.cwd(), undefined)).rejects.toThrow("inactive");
  });

  it("does not emit search_tools on agent-tools:register", () => {
    const stub = createHarness(["search_tools"], eventBus());
    toolManager(stub.api);
    expect(stub.bus.emitted.filter((event) => event.event === "agent-tools:register")).toEqual([]);
  });
});
