import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../tool-registry";

function pi(active: string[]) {
  const tools: any[] = [
    { name: "read", description: "read", parameters: {}, sourceInfo: { source: "builtin" } },
    { name: "external", description: "external", parameters: {}, sourceInfo: { source: "extension" } },
  ];
  return {
    registerTool(tool: any) { tools.push({ ...tool, sourceInfo: { source: "extension" } }); },
    getActiveTools: () => active,
    getAllTools: () => tools,
    on() {},
    events: { emit() {}, on() {} },
  } as any;
}

describe("ToolRegistry active filtering", () => {
  it("excludes inactive tools from ptc availability", () => {
    const stub = pi(["read"]);
    const registry = new ToolRegistry(stub);
    expect(registry.getAvailableTools(stub).map((tool) => tool.name)).toEqual(["read"]);
  });

  it("rejects direct dispatch of inactive tools before execution", async () => {
    const stub = pi([]);
    const registry = new ToolRegistry(stub);
    await expect(registry.dispatch("read", {}, process.cwd(), undefined)).rejects.toThrow("inactive");
  });

  it("dispatches active captured extension tools", async () => {
    const stub = pi(["external"]);
    const registry = new ToolRegistry(stub);
    stub.registerTool({
      name: "external",
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
    await expect(registry.dispatch("external", {}, process.cwd(), undefined)).resolves.toBe("ok");
  });
});
