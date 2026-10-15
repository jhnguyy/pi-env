import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  DagExecutorKind,
  buildDagSubagentPrompt,
  parseDagSubagentPayload,
  type DagSubagentRuntimeRequest,
} from "../../../../src/dag/index.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const shared = {
  calls: [] as any[],
  result: {
    details: {
      finalOutput: "complete result",
      isError: false,
      turnLimitExceeded: false,
    },
  } as any,
};

import {
  DagSubagentExecutorKey,
  createDagSubagentExecutorRegistry,
  makeDagSubagentRuntime,
} from "../dag-runtime";

const roots: string[] = [];
afterEach(() => {
  shared.calls.length = 0;
  shared.result = {
    details: { finalOutput: "complete result", isError: false, turnLimitExceeded: false },
  };
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "pi-dag-subagent-runtime-"));
  roots.push(value);
  return value;
}

function context(cwd: string, model: unknown, trusted = true): any {
  return {
    cwd,
    isProjectTrusted: () => trusted,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "test" && id === "model" ? model : undefined,
      getAvailable: () => [model],
    },
  };
}

function request(cwd: string, overrides: Record<string, unknown> = {}): DagSubagentRuntimeRequest {
  const payload = parseDagSubagentPayload({
    v: 1,
    name: "child",
    instructions: "Do the task.",
    model: "test/model",
    tools: [],
    workspace: { cwd, access: "read" },
    context: { outputs: [] },
    output: { name: "answer" },
    ...overrides,
  });
  return {
    runId: "run",
    nodeId: "node",
    attemptId: "run:node:1",
    payload,
    prompt: buildDagSubagentPrompt(payload, { outputs: [], bytes: 0 }),
  };
}

async function failure(effect: Effect.Effect<string, unknown>): Promise<any> {
  return Effect.runPromise(Effect.flip(effect));
}

const executeResolved: NonNullable<
  Parameters<typeof makeDagSubagentRuntime>[1]["executeResolved"]
> = (run, _ctx, options) => {
  shared.calls.push({ run, options });
  return Effect.succeed(shared.result);
};

function adapter(ctx: any, tools: readonly ToolDefinition[] = []) {
  return makeDagSubagentRuntime(ctx, { executeResolved, customToolsForRun: () => tools });
}

describe("DAG shared subagent runtime adapter", () => {
  it("passes only the explicit model and empty tool whitelist and returns the full result", async () => {
    const cwd = root();
    const runtime = adapter(context(cwd, { provider: "test", id: "model", contextWindow: 32_000 }));

    await expect(Effect.runPromise(runtime.run(request(cwd, { reasoning: "high" })))).resolves.toBe(
      "complete result",
    );
    expect(shared.calls).toHaveLength(1);
    expect(shared.calls[0].run).toMatchObject({
      modelOverride: "test/model",
      toolNames: [],
      customTools: [],
      cwd,
      workspaceAccess: "read",
      reasoning: "high",
    });
  });

  it("accepts one complete tool-free response at the explicit one-request boundary", async () => {
    const cwd = root();
    const runtime = adapter(context(cwd, { provider: "test", id: "model", contextWindow: 32_000 }));
    shared.result = {
      details: {
        finalOutput: '{"role":"correctness","findings":[]}',
        isError: false,
        turnLimitExceeded: true,
        usage: { turns: 1 },
      },
    };

    await expect(Effect.runPromise(runtime.run(request(cwd, { maxTurns: 1 })))).resolves.toContain(
      '"role":"correctness"',
    );
    expect(shared.calls).toHaveLength(1);
  });

  it("passes explicitly assigned run-local custom tools", async () => {
    const cwd = root();
    const reviewTool = {
      name: "review_private",
      label: "Review",
      description: "private review tool",
      parameters: {},
      execute: async () => ({ content: [] }),
    } as any;
    const ctx = context(cwd, { provider: "test", id: "model", contextWindow: 32_000 });
    await expect(
      Effect.runPromise(
        adapter(ctx, [reviewTool]).run(
          request(cwd, { tools: ["review_private"] }),
        ),
      ),
    ).resolves.toBe("complete result");
    expect(shared.calls.at(-1)?.run.toolNames).toEqual(["review_private"]);
    expect(shared.calls.at(-1)?.run.customTools).toEqual([reviewTool]);
  });

  it("rejects a cwd outside the parent workspace", async () => {
    const parent = root();
    const outside = root();
    const runtime = adapter(
      context(parent, { provider: "test", id: "model", contextWindow: 32_000 }),
    );

    expect((await failure(runtime.run(request(outside)))).phase).toBe("resolution");
    expect(shared.calls).toHaveLength(0);
  });

  it("uses a run-scoped workspace authority outside the parent checkout", async () => {
    const parent = root();
    const managed = root();
    const outside = root();
    const ctx = context(parent, { provider: "test", id: "model", contextWindow: 32_000 });
    const runtime = makeDagSubagentRuntime(ctx, {
      workspaceRootForRun: (runId) => (runId === "run" ? managed : undefined),
      executeResolved,
    });

    await expect(Effect.runPromise(runtime.run(request(managed)))).resolves.toBe("complete result");
    expect((await failure(runtime.run(request(outside)))).phase).toBe("resolution");
  });

  it("requires trust for project agents and uses only their system prompt", async () => {
    const cwd = root();
    const agents = join(cwd, ".pi", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, "project-agent.md"),
      "---\nname: project-agent\ndescription: project agent\ntools: bash\nmodel: ambient/model\n---\nProject system prompt.\n",
    );
    const selected = request(cwd, { agent: { name: "project-agent", scope: "project" } });

    expect(
      (
        await failure(
          adapter(
            context(cwd, { provider: "test", id: "model", contextWindow: 32_000 }, false),
          ).run(selected),
        )
      ).phase,
    ).toBe("resolution");
    await Effect.runPromise(
      adapter(context(cwd, { provider: "test", id: "model", contextWindow: 32_000 }, true)).run(
        selected,
      ),
    );
    expect(shared.calls[0].run.modelOverride).toBe("test/model");
    expect(shared.calls[0].run.toolNames).toEqual([]);
    expect(shared.calls[0].run.systemPrompt).toContain("Project system prompt.");
    expect(shared.calls[0].run.systemPrompt).toMatch(/explicitly provided tools\.$/u);
  });

  it("registers only the versioned subagent executor key", async () => {
    const cwd = root();
    const ctx = context(cwd, { provider: "test", id: "model", contextWindow: 32_000 });
    const registry = createDagSubagentExecutorRegistry(ctx, cwd, "generation", {});

    await expect(
      Effect.runPromise(registry.lookup(DagExecutorKind.Subagent, DagSubagentExecutorKey)),
    ).resolves.toBeTypeOf("function");
    await expect(
      Effect.runPromise(registry.lookup(DagExecutorKind.Subagent, "other")),
    ).resolves.toBeUndefined();
  });

  it("converts child error and turn-limit results to execution failures", async () => {
    const cwd = root();
    const runtime = adapter(context(cwd, { provider: "test", id: "model", contextWindow: 32_000 }));
    shared.result = {
      details: { finalOutput: "partial", isError: true, turnLimitExceeded: false },
    };
    expect((await failure(runtime.run(request(cwd)))).phase).toBe("execution");
    shared.result = {
      details: { finalOutput: "partial", isError: false, turnLimitExceeded: true },
    };
    expect((await failure(runtime.run(request(cwd)))).phase).toBe("execution");
  });
});
