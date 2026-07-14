import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SEARCH_TOOL_NAME, resolveConfig } from "../core";
import { handleToolsCommand } from "../index";

function harness() {
  let active = ["read", SEARCH_TOOL_NAME];
  const entries: unknown[] = [];
  const tools = ["read", "bash", SEARCH_TOOL_NAME, "analyze", "notes"].map((name) => ({ name, label: name, description: name, parameters: {}, sourceInfo: { source: "test" } as any }));
  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => { active = next; },
    appendEntry: (_type: string, data: unknown) => { entries.push(data); },
  } as unknown as ExtensionAPI;
  const notify = vi.fn();
  const custom = vi.fn(async (factory: any) => factory({ requestRender: vi.fn() }, { fg: (_s: string, t: string) => t, bold: (t: string) => t }, {}, vi.fn()));
  const ctx = { mode: "tui", ui: { notify, custom } } as unknown as ExtensionCommandContext;
  return { pi, ctx, notify, custom, entries, get active() { return active; } };
}

describe("/tools command", () => {
  it("opens custom TUI with no args in TUI mode", async () => {
    const h = harness();
    await handleToolsCommand(h.pi, "", h.ctx, resolveConfig({ alwaysActive: ["notes"] }));
    expect(h.custom).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("falls back to notify with no args outside TUI", async () => {
    const h = harness();
    await handleToolsCommand(h.pi, "", { ...h.ctx, mode: "print" } as ExtensionCommandContext, resolveConfig());
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Active tools"), "info");
  });

  it("rejects unknown profiles without changing or persisting state", async () => {
    const h = harness();
    await handleToolsCommand(h.pi, "profile missing", h.ctx, resolveConfig());
    expect(h.active).toEqual(["read", SEARCH_TOOL_NAME]);
    expect(h.entries).toEqual([]);
    expect(h.notify).toHaveBeenCalledWith("Unknown profile: missing", "error");
  });

  it("prevents alwaysActive tools from being disabled", async () => {
    const h = harness();
    await handleToolsCommand(h.pi, "off notes", h.ctx, resolveConfig({ alwaysActive: ["notes"] }));
    expect(h.active).toEqual(["read", SEARCH_TOOL_NAME, "notes"]);
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Disabled: -"), "info");
  });

  it("reports actual on/off changes and unknown names", async () => {
    const h = harness();
    await handleToolsCommand(h.pi, "on analyze missing", h.ctx, resolveConfig());
    expect(h.active).toContain("analyze");
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Unknown: missing"), "warning");
    await handleToolsCommand(h.pi, "off analyze missing", h.ctx, resolveConfig());
    expect(h.active).not.toContain("analyze");
    expect(h.active).toContain(SEARCH_TOOL_NAME);
    expect(h.notify).toHaveBeenLastCalledWith(expect.stringContaining("Disabled: analyze"), "warning");
  });

  it("applies and persists profiles, then resets to the configured default", async () => {
    const h = harness();
    const config = resolveConfig({
      defaultProfile: "minimal",
      profiles: { minimal: ["read"], analysis: ["read", "analyze"] },
    });

    await handleToolsCommand(h.pi, "profile analysis", h.ctx, config);
    expect(h.active).toEqual(["read", "analyze", SEARCH_TOOL_NAME]);
    expect(h.entries).toHaveLength(1);

    await handleToolsCommand(h.pi, "reset", h.ctx, config);
    expect(h.active).toEqual(["read", SEARCH_TOOL_NAME]);
    expect(h.entries).toHaveLength(2);
  });
});
