import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, it, vi } from "vitest";
import registerSkillBuilder from "../index";

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
