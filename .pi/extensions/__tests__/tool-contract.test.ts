import { describe, expect, it } from "vitest";
import { Type, type Static } from "typebox";

import { toAgentTool, toPiTool, type ToolContract } from "../_shared/tool-contract";

const PARAMETERS = Type.Object({ value: Type.String() });
type Params = Static<typeof PARAMETERS>;

function createContract(seen: Array<{ params: Params; cwd: string; signal?: AbortSignal }>): ToolContract<Params, { cwd: string }> {
  return {
    name: "sample",
    label: "Sample",
    description: "Shared sample tool",
    parameters: PARAMETERS,
    async execute(params, context) {
      seen.push({ params, cwd: context.cwd, signal: context.signal });
      context.progress?.(`cwd:${context.cwd}`);
      return { content: [{ type: "text", text: params.value }], details: { cwd: context.cwd } };
    },
  };
}

describe("shared tool contract adapters", () => {
  it("keeps Pi and AgentTool metadata/schema equivalent", () => {
    const contract = createContract([]);
    const piTool = toPiTool(contract);
    const agentTool = toAgentTool(contract, () => ({ cwd: "/session" }));

    expect(agentTool.name).toBe(piTool.name);
    expect(agentTool.label).toBe(piTool.label);
    expect(agentTool.description).toBe(piTool.description);
    expect(agentTool.parameters).toBe(piTool.parameters);
  });

  it("uses Pi ctx.cwd per invocation and forwards signals", async () => {
    const seen: Array<{ cwd: string; signal?: AbortSignal }> = [];
    const tool = toPiTool(createContract(seen as any));
    const first = new AbortController();
    const second = new AbortController();

    await tool.execute("1", { value: "a" }, first.signal, undefined, { cwd: "/one" } as any);
    await tool.execute("2", { value: "b" }, second.signal, undefined, { cwd: "/two" } as any);

    expect(seen.map((entry) => entry.cwd)).toEqual(["/one", "/two"]);
    expect(seen.map((entry) => entry.signal)).toEqual([first.signal, second.signal]);
  });

  it("uses explicit AgentTool session context provider and forwards signal", async () => {
    const seen: Array<{ cwd: string; signal?: AbortSignal }> = [];
    let cwd = "/captured";
    const tool = toAgentTool(createContract(seen as any), () => ({ cwd }));
    const controller = new AbortController();

    await tool.execute("agent", { value: "x" }, controller.signal);
    cwd = "/changed";
    await tool.execute("agent", { value: "y" });

    expect(seen).toMatchObject([{ cwd: "/captured" }, { cwd: "/changed" }]);
    expect(seen[0].signal).toBe(controller.signal);
  });

  it("forwards compact progress shape through both callbacks", async () => {
    const piUpdates: unknown[] = [];
    const agentUpdates: unknown[] = [];
    const contract = createContract([]);

    await toPiTool(contract).execute("pi", { value: "p" }, undefined, (update) => piUpdates.push(update), { cwd: "/pi" } as any);
    await toAgentTool(contract, () => ({ cwd: "/agent" })).execute("agent", { value: "a" }, undefined, (update) => agentUpdates.push(update));

    expect(piUpdates).toEqual([{ content: [{ type: "text", text: "cwd:/pi" }], details: { phase: "cwd:/pi" } }]);
    expect(agentUpdates).toEqual([{ content: [{ type: "text", text: "cwd:/agent" }], details: { phase: "cwd:/agent" } }]);
  });
});
