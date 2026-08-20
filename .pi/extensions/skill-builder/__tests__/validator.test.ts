import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeIfEnabled } from "../../__tests__/test-utils";
import { validateSkill } from "../validator";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-validator-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeSkill(name: string, content: string): string {
  const dir = join(tempDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
  return dir;
}

function createSkill(
  dirName: string,
  frontmatter: Record<string, unknown> = {},
  body = "# My Skill\n\nInstructions here.",
): string {
  const values = {
    name: dirName,
    description: "Performs a focused task. Use when that task is required.",
    ...frontmatter,
  };
  const yaml = Object.entries(values)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  return writeSkill(dirName, `---\n${yaml}\n---\n\n${body}`);
}

describeIfEnabled("skill-builder", "Validator", () => {
  describe("directory structure", () => {
    it("fails when the path does not exist", () => {
      const result = validateSkill(join(tempDir, "nonexistent"));
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue) => issue.rule === "dir-exists")).toBe(true);
    });

    it("fails when SKILL.md is missing", () => {
      const dir = join(tempDir, "empty-skill");
      mkdirSync(dir);
      const result = validateSkill(dir);
      expect(result.issues.some((issue) => issue.rule === "skill-md-exists")).toBe(true);
    });

    it("passes a valid minimal skill", () => {
      const result = validateSkill(createSkill("my-skill"));
      expect(result.valid).toBe(true);
      expect(result.name).toBe("my-skill");
    });
  });

  describe("frontmatter", () => {
    it("fails when frontmatter is missing", () => {
      const result = validateSkill(writeSkill("no-frontmatter", "# No Frontmatter\n"));
      expect(result.issues.some((issue) => issue.rule === "frontmatter-exists")).toBe(true);
    });

    it("accepts quoted and multiline YAML and a name that differs from the directory", () => {
      const dir = writeSkill(
        "directory-name",
        [
          "---",
          'name: "frontmatter-name"',
          "description: |",
          "  First line.",
          "  Second line.",
          "---",
          "",
          "# Skill",
        ].join("\n"),
      );
      const result = validateSkill(dir);
      expect(result.valid).toBe(true);
      expect(result.name).toBe("frontmatter-name");
      expect(result.issues.some((issue) => issue.rule === "name-matches-dir")).toBe(false);
    });

    it("fails on malformed YAML", () => {
      const dir = writeSkill(
        "bad-yaml",
        "---\nname: [oops\ndescription: Valid description.\n---\n\nBody.",
      );
      const result = validateSkill(dir);
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue) => issue.rule === "frontmatter-parse")).toBe(true);
    });

    it("requires an explicit name", () => {
      const dir = writeSkill("missing-name", "---\ndescription: Valid description.\n---\n\nBody.");
      expect(validateSkill(dir).issues.some((issue) => issue.rule === "name-exists")).toBe(true);
    });

    it("requires a description", () => {
      const dir = writeSkill("missing-description", "---\nname: missing-description\n---\n\nBody.");
      expect(validateSkill(dir).issues.some((issue) => issue.rule === "description-exists")).toBe(
        true,
      );
    });

    it("rejects non-string names and descriptions", () => {
      const dir = writeSkill("bad-types", "---\nname: 123\ndescription: [one, two]\n---\n\nBody.");
      const result = validateSkill(dir);
      expect(result.issues.some((issue) => issue.rule === "name-type")).toBe(true);
      expect(result.issues.some((issue) => issue.rule === "description-type")).toBe(true);
    });

    it("accepts a short specific description", () => {
      const result = validateSkill(
        createSkill("short-description", { description: "Checks YAML." }),
      );
      expect(result.valid).toBe(true);
      expect(result.issues.some((issue) => issue.rule === "description-quality")).toBe(false);
    });

    it.each([
      { condition: "contains uppercase", name: "My-Skill" },
      { condition: "has consecutive hyphens", name: "my--skill" },
      { condition: "starts with a hyphen", name: "-my-skill" },
      { condition: "ends with a hyphen", name: "my-skill-" },
    ])("rejects a name that $condition", ({ name }) => {
      const result = validateSkill(createSkill("skill-directory", { name }));
      expect(result.issues.some((issue) => issue.rule === "name-format")).toBe(true);
    });

    it("rejects overlong names and descriptions", () => {
      const result = validateSkill(
        createSkill("long-fields", {
          name: "a".repeat(65),
          description: "x".repeat(1025),
        }),
      );
      expect(result.issues.some((issue) => issue.rule === "name-length")).toBe(true);
      expect(result.issues.some((issue) => issue.rule === "description-length")).toBe(true);
    });
  });

  describe("references", () => {
    it("warns when a referenced file does not exist", () => {
      const result = validateSkill(
        createSkill("broken-ref", {}, "# Skill\n\nRun `./scripts/setup.sh`."),
      );
      expect(result.issues.some((issue) => issue.rule === "reference-exists")).toBe(true);
    });

    it("rejects a reference outside the skill directory", () => {
      const result = validateSkill(
        createSkill("outside-ref", {}, "# Skill\n\nSee [secret](../secret.md)."),
      );
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue) => issue.rule === "reference-scope")).toBe(true);
    });

    it("accepts an existing in-scope reference", () => {
      const dir = createSkill("good-ref", {}, "# Skill\n\nRun `./scripts/setup.sh`.");
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "setup.sh"), "#!/bin/sh\n");
      expect(validateSkill(dir).issues.some((issue) => issue.rule.startsWith("reference-"))).toBe(
        false,
      );
    });
  });
});
