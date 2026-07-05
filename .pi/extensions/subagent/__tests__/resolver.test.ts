import { describe, expect, it } from "vitest";
import {
  ResolutionErrorReason,
  ResolutionResultTag,
  resolveModel,
  resolveSubagentExecutionPlan,
  resolveSystemPrompt,
  resolveTools,
  type AgentConfig,
} from "../resolver";
import { ToolCapability } from "../types";

const modelRegistry = {
  find: (provider: string, id: string) => {
    if (provider === "anthropic" && id === "claude-haiku-4-5") return { provider, id };
    return undefined;
  },
  getAvailable: () => [
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "openai", id: "gpt-5.4-mini" },
  ],
  getApiKeyForProvider: async () => "test-key",
} as any;

const readExtTool = {
  name: "notes",
  label: "Notes",
  description: "Read notes",
  parameters: {},
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: null }),
} as any;

function agentConfig(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: "scout",
    path: "/tmp/scout.md",
    tools: undefined,
    capabilities: undefined,
    model: undefined,
    systemPrompt: undefined,
    ...overrides,
  } as AgentConfig;
}

describe("subagent resolver", () => {
  it("resolves explicit built-in and extension tools", () => {
    const extTools = new Map([["notes", readExtTool]]);
    const result = resolveTools(
      { task: "x", tools: ["read", "notes"] },
      undefined,
      extTools,
      undefined,
      "/tmp",
    );

    expect(result._tag).toBe(ResolutionResultTag.Ok);
    if (result._tag !== ResolutionResultTag.Ok) return;
    expect(result.value.toolNames).toEqual(["read", "notes"]);
    expect(result.value.tools).toHaveLength(2);
  });

  it("resolves tools by capability subset", () => {
    const extTools = new Map([["notes", readExtTool]]);
    const extCaps = new Map([["notes", [ToolCapability.Read]]]);
    const result = resolveTools(
      { task: "x" },
      agentConfig({ capabilities: [ToolCapability.Read] }),
      extTools,
      extCaps,
      "/tmp",
    );

    expect(result._tag).toBe(ResolutionResultTag.Ok);
    if (result._tag !== ResolutionResultTag.Ok) return;
    expect(result.value.toolNames).toContain("read");
    expect(result.value.toolNames).toContain("notes");
    expect(result.value.toolNames).not.toContain("bash");
  });

  it("reports only explicitly requested unknown tools", () => {
    const result = resolveTools(
      { task: "x", tools: ["missing"] },
      agentConfig({ capabilities: [ToolCapability.Read] }),
      new Map(),
      undefined,
      "/tmp",
    );

    expect(result._tag).toBe(ResolutionResultTag.Error);
    if (result._tag !== ResolutionResultTag.Error) return;
    expect(result.error.reason).toBe(ResolutionErrorReason.InvalidTools);
    expect(result.error.toolNames).toEqual(["missing"]);
  });

  it("resolves provider/id and bare model names", () => {
    expect(resolveModel("anthropic/claude-haiku-4-5", modelRegistry, ["read"])._tag).toBe(ResolutionResultTag.Ok);
    expect(resolveModel("gpt-5.4-mini", modelRegistry, ["read"])._tag).toBe(ResolutionResultTag.Ok);
  });

  it("returns no_model with resolved tool names", () => {
    const result = resolveModel(undefined, modelRegistry, ["read"]);
    expect(result._tag).toBe(ResolutionResultTag.Error);
    if (result._tag !== ResolutionResultTag.Error) return;
    expect(result.error.reason).toBe(ResolutionErrorReason.NoModel);
    expect(result.error.toolNames).toEqual(["read"]);
  });

  it("prefers explicit system prompt over agent prompt", () => {
    expect(resolveSystemPrompt(
      { task: "x", system_prompt: "explicit" },
      agentConfig({ systemPrompt: "agent" }),
    )).toBe("explicit");
  });

  it("builds a complete execution plan", () => {
    const result = resolveSubagentExecutionPlan(
      { task: "x", tools: ["notes"], model: "anthropic/claude-haiku-4-5" },
      { cwd: "/tmp", modelRegistry } as any,
      new Map([["notes", readExtTool]]),
    );

    expect(result._tag).toBe(ResolutionResultTag.Ok);
    if (result._tag !== ResolutionResultTag.Ok) return;
    expect(result.value.toolNames).toEqual(["notes"]);
    expect(result.value.systemPrompt).toContain("Complete the task");
  });
});
