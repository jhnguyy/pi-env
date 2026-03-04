import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { validateSkill } from "../validator";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-validator-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Helper: create a minimal valid skill directory. */
function createSkill(
  name: string,
  frontmatter: Record<string, string | boolean> = {},
  body: string = "# My Skill\n\nInstructions here.",
): string {
  const skillDir = join(tempDir, name);
  mkdirSync(skillDir, { recursive: true });

  const fm = { name, description: "A useful skill for doing things.", ...frontmatter };
  const fmBlock = Object.entries(fm)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : String(v)}`)
    .join("\n");

  writeFileSync(join(skillDir, "SKILL.md"), `---\n${fmBlock}\n---\n\n${body}`);
  return skillDir;
}

describeIfEnabled("skill-builder", "Validator", () => {
  // ─── Directory Structure ───────────────────────────────────────

  describe("directory structure", () => {
    it("fails when path does not exist", () => {
      const result = validateSkill(join(tempDir, "nonexistent"));
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.rule === "dir-exists")).toBe(true);
    });

    it("fails when SKILL.md is missing", () => {
      const dir = join(tempDir, "empty-skill");
      mkdirSync(dir);
      const result = validateSkill(dir);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => i.rule === "skill-md-exists")).toBe(true);
    });

    it("passes with a valid minimal skill", () => {
      const dir = createSkill("my-skill");
      const result = validateSkill(dir);
      expect(result.valid).toBe(true);
      expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    });
  });

  // ─── Name Validation ──────────────────────────────────────────

  describe("name validation", () => {
    it("fails when name contains uppercase", () => {
      const dir = createSkill("My-Skill", { name: "My-Skill" });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "name-format")).toBe(true);
    });

    it("fails when name has consecutive hyphens", () => {
      const dir = createSkill("my--skill", { name: "my--skill" });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "name-format")).toBe(true);
    });

    it("fails when name starts with hyphen", () => {
      const dir = createSkill("-my-skill", { name: "-my-skill" });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "name-format")).toBe(true);
    });

    it("fails when name ends with hyphen", () => {
      const dir = createSkill("my-skill-", { name: "my-skill-" });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "name-format")).toBe(true);
    });

    it("fails when name exceeds 64 characters", () => {
      const longName = "a".repeat(65);
      const dir = createSkill(longName, { name: longName });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "name-length")).toBe(true);
    });

    it("warns when name doesn't match directory name", () => {
      const dir = createSkill("my-skill", { name: "other-name" });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "name-matches-dir")).toBe(true);
    });

    it("passes with valid lowercase-hyphen name matching directory", () => {
      const dir = createSkill("code-review");
      const result = validateSkill(dir);
      const nameIssues = result.issues.filter((i) => i.rule.startsWith("name-"));
      expect(nameIssues.filter((i) => i.severity === "error")).toHaveLength(0);
    });
  });

  // ─── Frontmatter ──────────────────────────────────────────────

  describe("frontmatter", () => {
    it("fails when frontmatter is missing entirely", () => {
      const dir = join(tempDir, "no-fm");
      mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), "# No Frontmatter\n\nJust a body.");
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "frontmatter-exists")).toBe(true);
    });

    it("fails when description is missing", () => {
      const dir = join(tempDir, "no-desc");
      mkdirSync(dir);
      writeFileSync(join(dir, "SKILL.md"), "---\nname: no-desc\n---\n\n# No Desc");
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "description-exists")).toBe(true);
    });

    it("fails when description exceeds 1024 characters", () => {
      const dir = createSkill("long-desc", { description: "x".repeat(1025) });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "description-length")).toBe(true);
    });
  });

  // ─── Description Quality ──────────────────────────────────────

  describe("description quality", () => {
    it("warns on vague description (too short / generic)", () => {
      const dir = createSkill("vague", { description: "Helps with stuff." });
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "description-quality")).toBe(true);
    });

    it("passes with a specific, actionable description", () => {
      const dir = createSkill("good-desc", {
        description:
          "Validates skill directories against the Agent Skills spec, checks frontmatter schema, naming conventions, and context efficiency. Use when building or reviewing skills.",
      });
      const result = validateSkill(dir);
      const qualityIssues = result.issues.filter((i) => i.rule === "description-quality");
      expect(qualityIssues).toHaveLength(0);
    });
  });

  // ─── Context Efficiency ───────────────────────────────────────

  describe("context efficiency", () => {
    it("warns when SKILL.md body exceeds 8KB", () => {
      const largeBody = "# Big Skill\n\n" + "x".repeat(9000);
      const dir = createSkill("big-skill", {}, largeBody);
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "context-size")).toBe(true);
    });

    it("info when SKILL.md body exceeds 4KB without references to external files", () => {
      const mediumBody = "# Medium Skill\n\n" + "Detailed instructions. ".repeat(250);
      const dir = createSkill("medium-skill", {}, mediumBody);
      const result = validateSkill(dir);
      expect(
        result.issues.some(
          (i) => i.rule === "context-compression" && i.severity === "info",
        ),
      ).toBe(true);
    });

    it("passes context-compression when body references external files", () => {
      const body =
        "# Indexed Skill\n\nSee [reference](references/api.md) for details.\n\n" +
        "More instructions. ".repeat(250);
      const dir = createSkill("indexed-skill", {}, body);
      // Create the referenced file
      mkdirSync(join(dir, "references"), { recursive: true });
      writeFileSync(join(dir, "references", "api.md"), "# API Reference\nDetails...");
      const result = validateSkill(dir);
      expect(
        result.issues.filter(
          (i) => i.rule === "context-compression" && i.severity === "info",
        ),
      ).toHaveLength(0);
    });
  });

  // ─── Broken References ────────────────────────────────────────

  describe("broken references", () => {
    it("warns when SKILL.md references a file that doesn't exist", () => {
      const body = "# My Skill\n\nRun the setup:\n```bash\n./scripts/setup.sh\n```";
      const dir = createSkill("broken-ref", {}, body);
      const result = validateSkill(dir);
      expect(result.issues.some((i) => i.rule === "reference-exists")).toBe(true);
    });

    it("passes when referenced files exist", () => {
      const body =
        "# My Skill\n\nRun the setup:\n```bash\n./scripts/setup.sh\n```";
      const dir = createSkill("good-ref", {}, body);
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts", "setup.sh"), "#!/bin/bash\necho hi");
      const result = validateSkill(dir);
      expect(result.issues.filter((i) => i.rule === "reference-exists")).toHaveLength(0);
    });
  });

  // ─── Aggregate ────────────────────────────────────────────────

  describe("aggregate result", () => {
    it("returns valid:false when any error-severity issue exists", () => {
      const dir = join(tempDir, "missing");
      const result = validateSkill(dir);
      expect(result.valid).toBe(false);
    });

    it("returns valid:true when only warnings exist", () => {
      const dir = createSkill("warn-only", { description: "Helps with stuff." });
      const result = validateSkill(dir);
      // Should have a description-quality warning but no errors
      expect(result.valid).toBe(true);
    });

    it("extracts skill name from frontmatter", () => {
      const dir = createSkill("named-skill");
      const result = validateSkill(dir);
      expect(result.name).toBe("named-skill");
    });
  });
});
