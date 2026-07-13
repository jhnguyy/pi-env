import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, it, vi } from "vitest";
import registerSkillBuilder, { runSkillBuild } from "../index";

const modelConfig = {
  provider: "test-provider",
  model: "test-model",
  costModel: "api" as const,
  costPerInputToken: 0,
  costPerOutputToken: 0,
};

function writeValidSkill(root: string): void {
  const skillDir = join(root, "review-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: review-skill\ndescription: Reviews a skill for specific actionable quality problems.\n---\n\n# Review Skill\n",
  );
}

it("does not evaluate placeholder scaffolds in create mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-builder-workflow-"));
  const tools = new Map<string, any>();
  const exec = vi.fn();
  const pi = {
    exec,
    on: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
  };

  try {
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
      { cwd: root, model: null },
    );

    expect(result.content[0].text).toContain("then review the skill by path");
    expect(exec).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("preserves review command, validation ordering, and bounded process failure output", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-builder-review-"));
  writeValidSkill(root);
  const stderr = `failure:${"x".repeat(250)}`;
  const exec = vi.fn(
    async (
      _command: string,
      _args: string[],
      _options: { signal?: AbortSignal; timeout?: number },
    ) => ({ code: 7, stdout: "private-stdout", stderr }),
  );

  try {
    const result = await runSkillBuild(
      { exec } as any,
      { path: "review-skill", diff: "+ changed line" },
      { cwd: root, modelConfig, env: {} },
    );

    const text = result.content[0]?.text ?? "";
    expect(text.indexOf("✓ Validate: passed")).toBeLessThan(text.indexOf("✗ Evaluate:"));
    expect(text).toContain(`✗ Evaluate: subagent failed (exit 7): ${stderr.slice(0, 200)}`);
    expect(text).not.toContain("private-stdout");
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]?.[0]).toBe("pi");
    expect(exec.mock.calls[0]?.[1].slice(0, 6)).toEqual([
      "-p",
      "--no-session",
      "--no-skills",
      "--no-extensions",
      "--tools",
      "",
    ]);
    expect(exec.mock.calls[0]?.[1].at(-1)).toContain("+ changed line");
    expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 60000 });
    expect(result.details).toMatchObject({
      skillDir: join(root, "review-skill"),
      validation: { valid: true },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("propagates caller cancellation through the Effect evaluation boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-builder-cancel-"));
  writeValidSkill(root);
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  let started!: () => void;
  const evaluationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const exec = vi.fn(
    async (_command: string, _args: string[], options: { signal: AbortSignal }) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((_resolve, reject) => {
        receivedSignal = options.signal;
        started();
        options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }),
  );

  try {
    const result = runSkillBuild(
      { exec } as any,
      { path: "review-skill" },
      { cwd: root, signal: controller.signal, modelConfig, env: {} },
    );
    await evaluationStarted;
    controller.abort();

    await expect(result).rejects.toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
