import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type * as ToolContractApi from "../_shared/tool-contract";
import * as RegisterContractTool from "../_shared/register-contract-tool";

const PARAMETERS = Type.Object({ value: Type.String() });
type Params = Static<typeof PARAMETERS>;
type Details = { cwd: string };
const PI_OPTIONS = {
  renderCall: () => ({ kind: "call" }) as any,
  renderResult: () => ({ kind: "result" }) as any,
};

function createContract(seen: Array<{ cwd: string; signal?: AbortSignal }>): ToolContractApi.ToolContract<Params, Details, typeof PARAMETERS> {
  return {
    name: "native_sample",
    label: "Cross Host Sample",
    description: "Shared native contract",
    parameters: PARAMETERS,
    async execute(_params, context) {
      seen.push({ cwd: context.cwd, signal: context.signal });
      context.progress?.(`cwd:${context.cwd}`);
      return { content: [{ type: "text", text: context.cwd }], details: { cwd: context.cwd } };
    },
  };
}

function createPiHarness() {
  const tools: ToolDefinition<any, any, any>[] = [];
  return { tools, pi: { registerTool(tool: ToolDefinition<any, any, any>) { tools.push(tool); } } };
}

describe("registerContractTool native contract", () => {
  it("passes Pi-only prompt and render metadata to Pi registration", () => {
    const harness = createPiHarness();
    const promptSnippet = "snippet";
    const promptGuidelines = ["guidelines"];
    const renderCall = () => ({ kind: "call" }) as any;
    const renderResult = () => ({ kind: "result" }) as any;

    RegisterContractTool.registerContractTool(harness.pi, {
      contract: createContract([]),
      piOptions: { promptSnippet, promptGuidelines, renderCall, renderResult, exposure: "deferred", namespace: { name: "pi-env" } },
    });

    expect(harness.tools[0]?.promptSnippet).toBe(promptSnippet);
    expect(harness.tools[0]?.promptGuidelines).toBe(promptGuidelines);
    expect(harness.tools[0]?.renderCall).toBe(renderCall);
    expect(harness.tools[0]?.renderResult).toBe(renderResult);
    expect(harness.tools[0]?.exposure).toBe("deferred");
    expect(harness.tools[0]?.namespace).toEqual({ name: "pi-env" });
  });

  it("forwards cancellation signal and progress in the native adapter", async () => {
    const seen: Array<{ cwd: string; signal?: AbortSignal }> = [];
    const harness = createPiHarness();
    const signal = new AbortController().signal;
    const piUpdates: AgentToolResult<unknown>[] = [];
    RegisterContractTool.registerContractTool(harness.pi, {
      contract: createContract(seen),
      piOptions: PI_OPTIONS,
    });

    const result = await harness.tools[0].execute("pi", { value: "p" }, signal, (update) => piUpdates.push(update as AgentToolResult<unknown>), { cwd: "/pi" } as ExtensionToolContext);

    expect(result.details).toEqual({ cwd: "/pi" });
    expect(harness.tools[0].parameters).toBe(PARAMETERS);
    expect(seen.map((entry) => entry.signal)).toEqual([signal]);
    expect(piUpdates).toEqual([{ content: [{ type: "text", text: "cwd:/pi" }], details: { phase: "cwd:/pi" } }]);
  });
});
