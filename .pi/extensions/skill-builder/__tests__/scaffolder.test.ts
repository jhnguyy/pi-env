import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeIfEnabled } from "../../__tests__/test-utils";
import { scaffoldSkill } from "../scaffolder";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-scaffolder-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describeIfEnabled("skill-builder", "Scaffolder", () => {
  it("rejects an existing skill directory", () => {
    mkdirSync(join(tempDir, "existing-skill"));
    writeFileSync(join(tempDir, "existing-skill", "SKILL.md"), "existing");

    const result = scaffoldSkill({
      name: "existing-skill",
      description: "Should not overwrite.",
      template: "basic",
      targetDir: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already exists/i);
  });

  it("does not modify an existing skill on collision", () => {
    const dir = join(tempDir, "existing-skill");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), "original content");

    scaffoldSkill({
      name: "existing-skill",
      description: "Should not overwrite.",
      template: "basic",
      targetDir: tempDir,
    });

    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe("original content");
  });
});
