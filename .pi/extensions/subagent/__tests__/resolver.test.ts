import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ResolutionErrorReason,
  ResolutionResultTag,
  resolveEffectiveCwd,
  resolveModel,
  resolveSubagentExecutionPlan,
  resolveSystemPrompt,
  resolveTools,
  type AgentConfig,
} from "../resolver";
import { WorkspaceAccess } from "../control";
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

function externalTools(capabilities: ToolCapability[] = [ToolCapability.Read]) {
  return new Map([["notes", { tool: readExtTool, capabilities }]]);
}

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
    const result = resolveTools(
      { task: "x", tools: ["read", "notes"] },
      undefined,
      externalTools(),
      "/tmp",
    );

    expect(result._tag).toBe(ResolutionResultTag.Ok);
    if (result._tag !== ResolutionResultTag.Ok) return;
    expect(result.value.toolNames).toEqual(["read", "notes"]);
    expect(result.value.tools).toHaveLength(2);
    expect(result.value.workspaceAccess).toBe(WorkspaceAccess.Read);
  });

  it("does not expose DAG-only extension tools to generic subagents", () => {
    const result = resolveTools(
      { task: "x", tools: ["review_private"] },
      undefined,
      new Map([
        [
          "review_private",
          {
            tool: { ...readExtTool, name: "review_private" },
            capabilities: [ToolCapability.Read],
            audience: "dag" as const,
          },
        ],
      ]),
      "/tmp",
    );
    expect(result._tag).toBe(ResolutionResultTag.Error);
    if (result._tag !== ResolutionResultTag.Error) return;
    expect(result.error.reason).toBe(ResolutionErrorReason.InvalidTools);
    expect(result.error.message).not.toContain("Available: review_private");
  });

  it("creates extension tools for the child cwd and active session generation", () => {
    const calls: any[] = [];
    const registration = {
      tool: readExtTool,
      capabilities: [ToolCapability.Read],
      sessionGeneration: "generation-1",
      createTool: (factoryContext: any) => {
        calls.push(factoryContext);
        return { ...readExtTool, name: "factory-notes" };
      },
    };
    const ctx = { cwd: "/tmp", modelRegistry } as any;
    const result = resolveSubagentExecutionPlan(
      {
        task: "x",
        tools: ["notes"],
        model: "anthropic/claude-haiku-4-5",
      },
      ctx,
      new Map([["notes", registration]]),
    );

    expect(result._tag).toBe(ResolutionResultTag.Ok);
    if (result._tag !== ResolutionResultTag.Ok) return;
    expect(result.value.tools[0]?.name).toBe("factory-notes");
    expect(calls).toEqual([{ cwd: "/tmp", sessionGeneration: "generation-1", parentContext: ctx }]);
  });

  it("resolves tools by capability subset", () => {
    const result = resolveTools(
      { task: "x" },
      agentConfig({ capabilities: [ToolCapability.Read] }),
      externalTools(),
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
      "/tmp",
    );

    expect(result._tag).toBe(ResolutionResultTag.Error);
    if (result._tag !== ResolutionResultTag.Error) return;
    expect(result.error.reason).toBe(ResolutionErrorReason.InvalidTools);
    expect(result.error.toolNames).toEqual(["missing"]);
  });

  it("resolves provider/id and bare model names", () => {
    expect(resolveModel("anthropic/claude-haiku-4-5", modelRegistry, ["read"])._tag).toBe(
      ResolutionResultTag.Ok,
    );
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
    expect(
      resolveSystemPrompt(
        { task: "x", system_prompt: "explicit" },
        agentConfig({ systemPrompt: "agent" }),
      ),
    ).toBe("explicit");
  });

  it("validates and canonicalizes only explicit cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-cwd-"));
    try {
      const ok = resolveEffectiveCwd({ task: "x", cwd: dir }, "/missing/default");
      expect(ok._tag).toBe(ResolutionResultTag.Ok);
      if (ok._tag === ResolutionResultTag.Ok) expect(ok.value).toBe(dir);
      const relative = resolveEffectiveCwd({ task: "x", cwd: "relative" }, dir);
      expect(relative._tag).toBe(ResolutionResultTag.Error);
      if (relative._tag === ResolutionResultTag.Error)
        expect(relative.error.reason).toBe(ResolutionErrorReason.InvalidCwd);
      const file = join(dir, "file");
      writeFileSync(file, "x");
      const notDir = resolveEffectiveCwd({ task: "x", cwd: file }, dir);
      expect(notDir._tag).toBe(ResolutionResultTag.Error);
      const implicit = resolveEffectiveCwd({ task: "x" }, "/missing/default");
      expect(implicit).toEqual({ _tag: ResolutionResultTag.Ok, value: "/missing/default" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a complete execution plan", () => {
    const result = resolveSubagentExecutionPlan(
      { task: "x", tools: ["notes"], model: "anthropic/claude-haiku-4-5" },
      { cwd: "/tmp", modelRegistry } as any,
      externalTools(),
    );

    expect(result._tag).toBe(ResolutionResultTag.Ok);
    if (result._tag !== ResolutionResultTag.Ok) return;
    expect(result.value.toolNames).toEqual(["notes"]);
    expect(result.value.systemPrompt).toContain("Complete the task");
  });
});
