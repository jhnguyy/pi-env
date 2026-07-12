import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ScopeMode, type AnalysisResult } from "../../../../src/analyze/model";
import analyzeExtension, { createAnalyzeTool } from "../index";

const result: AnalysisResult = {
  version: 1,
  summary: { info: 0, warning: 2, error: 0, failures: 0 },
  findings: [
    { id: "1", analyzer: "complexity", kind: "complexity", severity: "warning", message: "first", location: { path: "a.ts", line: 1, column: 1 } },
    { id: "2", analyzer: "complexity", kind: "complexity", severity: "warning", message: "second", location: { path: "b.ts", line: 2, column: 1 } },
  ],
  analyzerFailures: [],
  benchmarks: [],
};

const execute = async (
  params: Parameters<ReturnType<typeof createAnalyzeTool>["execute"]>[1],
  runner = vi.fn(async () => result),
  signal = new AbortController().signal,
) => {
  const tool = createAnalyzeTool(runner);
  const output = await tool.execute("call", params, signal, undefined);
  return { output, runner };
};

describe("analyze tool", () => {
  it("registers the same capability for agents and subagents", () => {
    const registerTool = vi.fn();
    const emit = vi.fn();
    let onSessionStart: (() => void) | undefined;
    analyzeExtension({
      registerTool,
      events: { emit },
      on: (event: string, handler: () => void) => { if (event === "session_start") onSessionStart = handler; },
    } as never);

    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "analyze" }));
    onSessionStart?.();
    expect(emit).toHaveBeenCalledWith("agent-tools:register", expect.objectContaining({
      tool: expect.objectContaining({ name: "analyze" }),
      capabilities: ["read", "execute"],
    }));
  });

  it("points the engine at the requested worktree and keeps output compact", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "analyze-tool-"));
    const { output, runner } = await execute({ worktree, scope: ScopeMode.Diff, ref: "main", max_findings: 1 });

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ cwd: worktree, scope: ScopeMode.Diff, ref: "main" }), expect.any(AbortSignal));
    expect(output.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Summary: 0 errors, 2 warnings") });
    expect(output.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("1 additional findings omitted") });
    expect(output.details).toMatchObject({ summary: result.summary, findings: [result.findings[0]], omittedFindings: 1 });
  });

  it("stops before filesystem or analyzer work when cancelled", async () => {
    const controller = new AbortController();
    const runner = vi.fn(async () => result);
    controller.abort();
    await expect(execute({ worktree: "/tmp" }, runner, controller.signal)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires absolute worktrees and paths for path scope", async () => {
    await expect(execute({ worktree: "relative" })).rejects.toThrow("absolute path");
    const worktree = mkdtempSync(join(tmpdir(), "analyze-tool-"));
    await expect(execute({ worktree, scope: ScopeMode.Paths })).rejects.toThrow("requires at least one path");
  });
});
