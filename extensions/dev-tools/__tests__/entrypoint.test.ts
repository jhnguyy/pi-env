import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { LspClient } from "../client";
import { registerDevTools } from "../index";

// Daemon connection failure is injected at its external transport boundary.
describe("native dev-tools", () => {
  it("does not dispatch an already-aborted rename", async () => {
    const tools: any[] = [];
    const client = new LspClient();
    const dispatch = vi.fn();
    vi.spyOn(client, "callEffect").mockImplementation(() => Effect.sync(dispatch));
    registerDevTools(
      { registerCommand() {}, registerTool: (tool: any) => tools.push(tool) } as any,
      client,
    );
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await tools
        .find((tool) => tool.name === "dev-tools")
        .execute(
          "cancelled",
          {
            action: "rename",
            path: "/synthetic.ts",
            line: 1,
            character: 1,
            newName: "renamed",
          },
          controller.signal,
        );
      expect(result).toMatchObject({ isError: true, details: null });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
  });

  it("forwards the live invocation signal to the client", async () => {
    const tools: any[] = [];
    const call = vi.fn().mockRejectedValue(new Error("cancelled"));
    registerDevTools(
      { registerCommand() {}, registerTool: (tool: any) => tools.push(tool) } as any,
      { call } as any,
    );
    const controller = new AbortController();
    await tools
      .find((tool) => tool.name === "dev-tools")
      .execute(
        "live",
        {
          action: "hover",
          path: "/synthetic.ts",
          line: 1,
          character: 1,
        },
        controller.signal,
      );
    expect(call.mock.calls[0][1]).toBe(controller.signal);
  });

  it("reports daemon failures for hover and rename", async () => {
    const tools: any[] = [];
    registerDevTools(
      {
        registerCommand() {},
        registerTool: (tool: any) => tools.push(tool),
      } as any,
      {
        call: async () => {
          throw new Error("daemon unavailable");
        },
      } as any,
    );
    const tool = tools.find((tool) => tool.name === "dev-tools");
    for (const action of ["hover", "rename"]) {
      const result = await tool.execute("failure", {
        action,
        path: "/tmp/x.ts",
        line: 1,
        character: 1,
        newName: "renamed",
      });
      expect(result).toMatchObject({ isError: true, details: null });
      expect(result.content[0].text).toContain("daemon unavailable");
    }
  });
});
