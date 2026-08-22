import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import registerSkillBuilder, {
  modelConfigFromModel,
  resetSkillEvaluationRunnerForTests,
  runSkillBuild,
  setSkillEvaluationRunnerForTests,
} from "../index";

const roots: string[] = [];

afterEach(() => {
  resetSkillEvaluationRunnerForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skill-builder-workflow-"));
  roots.push(root);
  return root;
}

function writeSkill(root: string, content?: string): void {
  const skillDir = join(root, "review-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    content ??
      "---\nname: review-skill\ndescription: Reviews a skill for specific quality problems.\n---\n\n# Review Skill\n",
  );
}

function model() {
  return {
    provider: "test-provider",
    id: "configured-model",
    cost: { input: 5, output: 20, cacheRead: 1, cacheWrite: 2 },
  };
}

function context(root: string): any {
  const current = model();
  return {
    cwd: root,
    model: current,
    modelRegistry: { getAvailable: () => [current] },
  };
}

function successfulChild(output?: string) {
  return {
    content: [],
    details: {
      name: "skill-evaluation-review-skill",
      task: "task",
      toolNames: [],
      modelOverride: "test-provider/configured-model",
      finalOutput:
        output ??
        JSON.stringify({
          verdict: "needs-revision",
          findings: [
            {
              category: "clarity",
              severity: "warning",
              message: "State the destructive-action boundary.",
            },
          ],
        }),
      toolCallCount: 0,
      usage: {
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 0,
        cost: 0.0042,
        turns: 1,
      },
      model: "actual-model",
      sessionFile: "/tmp/sub-skill.jsonl",
      sessionName: "sub-skill-evaluation-review-skill",
      isError: false,
      turnLimitExceeded: false,
    },
  } as any;
}

it("adapts Pi per-million-token model rates without changing their units", () => {
  expect(modelConfigFromModel(model())).toMatchObject({
    costPerMillionInputTokens: 5,
    costPerMillionOutputTokens: 20,
  });
});

it("does not evaluate placeholder scaffolds in create mode", async () => {
  const root = tempRoot();
  const tools = new Map<string, any>();
  const exec = vi.fn();
  const pi = {
    exec,
    on: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
  };

  registerSkillBuilder(pi as any);
  const result = await tools.get("skill_build").execute(
    "call-id",
    {
      name: "concise-skill",
      description: "Performs one focused task.",
      template: "basic",
      targetDir: "skills",
    },
    undefined,
    undefined,
    context(root),
  );

  expect(result.content[0].text).toContain("then validate the skill by path");
  expect(exec).not.toHaveBeenCalled();
});

it("defaults an existing path to deterministic validation", async () => {
  const root = tempRoot();
  writeSkill(root);
  const exec = vi.fn();
  const runner = vi.fn();
  setSkillEvaluationRunnerForTests(runner as any);

  const result = await runSkillBuild(
    { exec } as any,
    { path: "review-skill" },
    { cwd: root, ctx: context(root), env: {} },
  );

  expect(result.content[0]?.text).toContain("✓ Validate: passed");
  expect(result.content[0]?.text).not.toContain("Advisory evaluation");
  expect(exec).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
});

it("requires a user goal for advisory evaluation", async () => {
  const root = tempRoot();
  writeSkill(root);
  const runner = vi.fn();
  setSkillEvaluationRunnerForTests(runner as any);

  const result = await runSkillBuild(
    { exec: vi.fn() } as any,
    { path: "review-skill", action: "evaluate" },
    { cwd: root, ctx: context(root), env: {} },
  );

  expect(result.content[0]?.text).toContain("Evaluate mode requires the user's goal");
  expect(runner).not.toHaveBeenCalled();
});

it("does not evaluate after deterministic validation errors", async () => {
  const root = tempRoot();
  writeSkill(root, "---\ndescription: Missing name.\n---\n\n# Invalid\n");
  const exec = vi.fn();
  const runner = vi.fn();
  setSkillEvaluationRunnerForTests(runner as any);

  const result = await runSkillBuild(
    { exec } as any,
    { path: "review-skill", action: "evaluate", goal: "Reduce recurring context." },
    { cwd: root, ctx: context(root), env: {} },
  );

  expect(result.content[0]?.text).toContain("✗ Validate:");
  expect(result.content[0]?.text).not.toContain("Advisory evaluation");
  expect(exec).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
});

it("uses the in-process subagent with the user goal and automatic Git diff", async () => {
  const root = tempRoot();
  writeSkill(root);
  const exec = vi.fn(async (command: string, args: string[]) => {
    expect(command).toBe("git");
    expect(args).toEqual(["diff", "HEAD", "--", "SKILL.md"]);
    return { code: 0, stdout: "+ changed instruction\n", stderr: "" };
  });
  const runner = vi.fn((run, _ctx, options) =>
    Effect.sync(() => {
      expect(run.task).toContain("## User Goal\n\nReduce recurring context.");
      expect(run.task).toContain("+ changed instruction");
      expect(run.tools).toEqual([]);
      expect(run.toolNames).toEqual([]);
      expect(run.workspaceAccess).toBe("read");
      expect(run.modelOverride).toBe("test-provider/configured-model");
      expect(options.signal).toBe(controller.signal);
      return successfulChild();
    }),
  );
  setSkillEvaluationRunnerForTests(runner as any);
  const controller = new AbortController();

  const result = await runSkillBuild(
    { exec } as any,
    { path: "review-skill", action: "evaluate", goal: "Reduce recurring context." },
    { cwd: root, ctx: context(root), signal: controller.signal, env: {} },
  );

  expect(runner).toHaveBeenCalledOnce();
  expect(exec.mock.calls.some(([command]) => command === "pi")).toBe(false);
  expect(result.content[0]?.text).toContain("Advisory evaluation: 1 finding(s) for user review");
  expect(result.content[0]?.text).toContain("Do not rerun only to obtain a pass");
  expect(result.details).toMatchObject({
    diffSource: "git-head",
    evaluation: {
      verdict: "needs-revision",
      tokenEconomy: {
        provider: "test-provider",
        model: "actual-model",
        inputTokens: 120,
        outputTokens: 30,
        estimatedCost: 0.0042,
      },
    },
    child: {
      sessionFile: "/tmp/sub-skill.jsonl",
      model: "actual-model",
    },
  });
  expect(result.usage).toMatchObject({
    input: 120,
    output: 30,
    cacheRead: 10,
    totalTokens: 160,
    cost: { total: 0.0042 },
  });
});

it("returns subagent failure as unavailable advisory review", async () => {
  const root = tempRoot();
  writeSkill(root);
  const exec = vi.fn(async () => ({ code: 0, stdout: "+ change\n", stderr: "" }));
  setSkillEvaluationRunnerForTests((() =>
    Effect.succeed({
      ...successfulChild(),
      details: {
        ...successfulChild().details,
        isError: true,
        errorMessage: "provider unavailable",
      },
    })) as any);

  const result = await runSkillBuild(
    { exec } as any,
    { path: "review-skill", action: "evaluate", goal: "Check the focused change." },
    { cwd: root, ctx: context(root), env: {} },
  );

  expect(result.content[0]?.text).toContain(
    "Advisory evaluation unavailable for user review (subagent failed).",
  );
  expect(result.content[0]?.text).not.toContain("provider unavailable");
  expect(result.content[0]?.text).toContain("✓ Validate: passed");
});

it("returns validation when advisory evaluation has no available model", async () => {
  const root = tempRoot();
  writeSkill(root);
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runner = vi.fn();
  setSkillEvaluationRunnerForTests(runner as any);
  const ctx = { cwd: root, modelRegistry: { getAvailable: () => [] } } as any;

  const result = await runSkillBuild(
    { exec } as any,
    { path: "review-skill", action: "evaluate", goal: "Review the skill." },
    { cwd: root, ctx, env: {} },
  );

  expect(result.content[0]?.text).toContain("✓ Validate: passed");
  expect(result.content[0]?.text).toContain("no model is available");
  expect(runner).not.toHaveBeenCalled();
});

it("does not start nested advisory evaluation from a subagent tool", async () => {
  const root = tempRoot();
  writeSkill(root);
  const runner = vi.fn();
  setSkillEvaluationRunnerForTests(runner as any);

  const result = await runSkillBuild(
    { exec: vi.fn() } as any,
    { path: "review-skill", action: "evaluate", goal: "Review the skill." },
    { cwd: root, ctx: context(root), allowEvaluation: false, env: {} },
  );

  expect(result.content[0]?.text).toContain("must run from the parent session");
  expect(runner).not.toHaveBeenCalled();
});
