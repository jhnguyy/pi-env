import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { createPtcToolCatalog } from "../catalog";
import { executePtcAction } from "../index";
import { PtcAction } from "../types";
import type { ToolRegistry } from "../tool-registry";

function tool(name: string): ToolInfo {
  return {
    name,
    description: `${name} test tool`,
    parameters: {},
    sourceInfo: {
      source: "extension",
      path: `/test/${name}`,
      scope: "project",
      origin: "top-level",
    },
  } as ToolInfo;
}

function registrySnapshot(callable: string[], unavailable: string[] = []): ToolRegistry {
  const availableTools = callable.map(tool);
  return {
    getRuntimeSnapshot: () => ({
      availableTools,
      catalog: createPtcToolCatalog(availableTools, unavailable),
    }),
  } as unknown as ToolRegistry;
}

describe("PTC actions", () => {
  it("keeps run as the default and accepts an explicit run action", async () => {
    const execute = vi.fn(async (code: string) => `ran:${code}`);
    const runtime = { execute };
    const registry = registrySnapshot([]);

    await expect(
      executePtcAction({ code: 'return "ok";' }, runtime, registry, "/cwd"),
    ).resolves.toEqual({ output: 'ran:return "ok";', details: {} });
    await expect(
      executePtcAction(
        { action: PtcAction.Run, code: 'return "ok";' },
        runtime,
        registry,
        "/cwd",
      ),
    ).resolves.toEqual({ output: 'ran:return "ok";', details: {} });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns the current catalog without starting the execution runtime", async () => {
    const execute = vi.fn(async () => "not used");
    const registry = registrySnapshot(["read", "dev-tools"], ["direct_only"]);

    const result = await executePtcAction(
      { action: PtcAction.Inspect },
      { execute },
      registry,
      "/cwd",
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.output).toContain("Nested tool result: Promise<string> (plain text).");
    expect(result.output).toContain('"dev_tools"(args?: Record<string, unknown>): Promise<string>;');
    expect(result.output).toContain('"dev-tools"(args?: Record<string, unknown>): Promise<string>;');
    expect(result.output).toContain("direct_only: This active direct tool has no PTC dispatcher. Call it directly.");
    expect(result.output).toContain("ptc: This tool is blocked inside PTC. Call it directly.");
    expect(result.details).toMatchObject({
      action: PtcAction.Inspect,
      catalog: {
        nestedReturnType: "Promise<string>",
        callable: expect.arrayContaining([expect.objectContaining({ name: "read", key: "read" })]),
        unavailable: [expect.objectContaining({ name: "direct_only" })],
      },
    });

    const declarationText = result.output.match(/```ts\n([\s\S]*?)\n```/)?.[1];
    expect(declarationText).toBeDefined();
    expect(() => transformSync(declarationText!, { loader: "ts" })).not.toThrow();
  });

  it("requires code only for the run action", async () => {
    await expect(
      executePtcAction({}, { execute: vi.fn() }, registrySnapshot([]), "/cwd"),
    ).rejects.toThrow('action="run" requires code');
  });
});
