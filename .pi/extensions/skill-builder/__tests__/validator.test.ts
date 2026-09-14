import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { describeIfEnabled } from "../../__tests__/test-utils";
import { validateSkill } from "../validator";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-validator-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createSkill(name: string, body = "# My Skill\n\nInstructions here."): string {
  const dir = join(tempDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Performs a focused task. Use when that task is required.\n---\n\n${body}`,
  );
  return dir;
}

describeIfEnabled("skill-builder", "Validator", () => {
  it("fails when the skill directory does not exist", () => {
    const result = validateSkill(join(tempDir, "nonexistent"));

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rule: "dir-exists", severity: "error" }),
    );
    expect(result.nativeDiagnostics).toEqual([]);
  });

  it("fails when the skill directory has no SKILL.md", () => {
    const dir = join(tempDir, "empty-skill");
    mkdirSync(dir);

    const result = validateSkill(dir);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rule: "skill-md-exists", severity: "error" }),
    );
    expect(result.nativeDiagnostics).toEqual([]);
  });

  it("warns when a referenced file does not exist", () => {
    const result = validateSkill(createSkill("broken-ref", "# Skill\n\nRun `./scripts/setup.sh`."));

    expect(result.valid).toBe(true);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rule: "reference-exists", severity: "warning" }),
    );
  });

  it("rejects a reference outside the skill directory", () => {
    const result = validateSkill(
      createSkill("outside-ref", "# Skill\n\nSee [secret](../secret.md)."),
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ rule: "reference-scope", severity: "error" }),
    );
  });

  it("accepts an existing reference inside the skill directory", () => {
    const dir = createSkill("good-ref", "# Skill\n\nRun `./scripts/setup.sh`.");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "setup.sh"), "#!/bin/sh\n");

    const result = validateSkill(dir);

    expect(result.issues.some((issue) => issue.rule.startsWith("reference-"))).toBe(false);
  });
});
