import { describe, expect, it } from "vitest";
import toolManager from "../index";
import { SEARCH_TOOL_NAME } from "../core";

function extensionHarness(branch: unknown[]) {
  const handlers = new Map<string, Function>();
  const entries: unknown[] = [];
  let active = ["read", "analyze", SEARCH_TOOL_NAME];
  const tools = ["read", "bash", "edit", "write", "dev-tools", "ptc", "analyze", "notes"].map((name) => ({ name, description: name, parameters: {}, sourceInfo: { source: "test" } as any }));
  return {
    pi: {
      registerTool(tool: any) { tools.push({ ...tool, sourceInfo: { source: "extension" } }); },
      registerCommand() {},
      on(event: string, handler: Function) { handlers.set(event, handler); },
      events: { emit() {}, on() {} },
      getAllTools: () => tools,
      getActiveTools: () => active,
      setActiveTools(next: string[]) { active = next; },
      appendEntry(_customType: string, data: unknown) { entries.push(data); },
    } as any,
    entries,
    handlers,
    tools,
    get active() { return active; },
  };
}

describe("tool manager branch restore", () => {
  it("uses current branch state and falls back to default profile when branch has none", () => {
    const h = extensionHarness([]);
    toolManager(h.pi);
    h.handlers.get("session_start")?.({}, { cwd: process.cwd(), sessionManager: { getBranch: () => [] } });
    expect(h.active).toEqual(["read", "bash", "edit", "write", "dev-tools", "ptc", SEARCH_TOOL_NAME]);
  });

  it("preserves search_tools on branch replay", () => {
    const sibling = { customType: "tool-manager:state", data: { active: ["read", "analyze", SEARCH_TOOL_NAME], reason: "toggle", at: "x" } };
    const h = extensionHarness([sibling]);
    toolManager(h.pi);
    h.handlers.get("session_tree")?.({}, { cwd: process.cwd(), sessionManager: { getBranch: () => [] } });
    expect(h.active).toContain(SEARCH_TOOL_NAME);
  });

  it("search_tools adds matches without removing active tools and persists the addition", async () => {
    const h = extensionHarness([]);
    toolManager(h.pi);
    const search = h.tools.find((tool) => tool.name === SEARCH_TOOL_NAME) as any;

    const result = await search.execute("id", { query: "notes" });

    expect(h.active).toEqual(["read", "analyze", SEARCH_TOOL_NAME, "notes"]);
    expect(result.details.loaded).toEqual(["notes"]);
    expect(h.entries).toHaveLength(1);
  });
});
