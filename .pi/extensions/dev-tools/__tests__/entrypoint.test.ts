import { describe, expect, it, vi } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";

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
    expect(guidance).toContain("dev-tools references to review all usages before renaming");
    expect(guidance).toContain("dev-tools incoming-calls before changing a callable signature");
    expect(guidance).toContain("outgoing-calls to map dependencies before refactoring");
    expect(guidance).toContain("dev-tools diagnostics to validate changed code");
    expect(guidance).toContain("Use rg only for text or pattern searches");
  });
});
