import { describe, expect, it } from "vitest";
import { registerDevTools } from "../index";

// Daemon connection failure is injected at its external transport boundary.
describe("native dev-tools", () => {
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
