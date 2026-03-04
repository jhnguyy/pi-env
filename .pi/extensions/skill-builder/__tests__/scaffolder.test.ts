import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
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
  describe("basic scaffold", () => {
    it("creates skill directory", () => {
      const result = scaffoldSkill({
        name: "my-tool",
        description: "A tool for doing things.",
        template: "basic",
        targetDir: tempDir,
      });
      expect(result.success).toBe(true);
      expect(existsSync(result.skillDir)).toBe(true);
    });

    it("creates SKILL.md in the skill directory", () => {
      const result = scaffoldSkill({
        name: "my-tool",
        description: "A tool for doing things.",
        template: "basic",
        targetDir: tempDir,
      });
      expect(existsSync(join(result.skillDir, "SKILL.md"))).toBe(true);
    });

    it("reports all files created", () => {
      const result = scaffoldSkill({
        name: "my-tool",
        description: "A tool for doing things.",
        template: "basic",
        targetDir: tempDir,
      });
      expect(result.filesCreated).toContain("SKILL.md");
    });

    it("SKILL.md content matches rendered template", () => {
      const result = scaffoldSkill({
        name: "my-tool",
        description: "A tool for doing things.",
        template: "basic",
        targetDir: tempDir,
      });
      const content = readFileSync(join(result.skillDir, "SKILL.md"), "utf-8");
      expect(content).toContain("name: my-tool");
      expect(content).toContain("A tool for doing things.");
    });
  });

  describe("with-scripts scaffold", () => {
    it("creates scripts directory", () => {
      const result = scaffoldSkill({
        name: "web-search",
        description: "Searches the web.",
        template: "with-scripts",
        targetDir: tempDir,
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(result.skillDir, "scripts"))).toBe(true);
    });

    it("creates placeholder script", () => {
      const result = scaffoldSkill({
        name: "web-search",
        description: "Searches the web.",
        template: "with-scripts",
        targetDir: tempDir,
      });
      const scripts = result.filesCreated.filter((f) => f.startsWith("scripts/"));
      expect(scripts.length).toBeGreaterThan(0);
    });
  });

  describe("with-index scaffold", () => {
    it("creates references directory", () => {
      const result = scaffoldSkill({
        name: "api-docs",
        description: "API documentation.",
        template: "with-index",
        targetDir: tempDir,
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(result.skillDir, "references"))).toBe(true);
    });

    it("creates placeholder reference file", () => {
      const result = scaffoldSkill({
        name: "api-docs",
        description: "API documentation.",
        template: "with-index",
        targetDir: tempDir,
      });
      const refs = result.filesCreated.filter((f) => f.startsWith("references/"));
      expect(refs.length).toBeGreaterThan(0);
    });
  });

  describe("collision handling", () => {
    it("fails when skill directory already exists", () => {
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

    it("does not modify existing files on collision", () => {
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

  describe("skill directory path", () => {
    it("uses name as directory name under targetDir", () => {
      const result = scaffoldSkill({
        name: "my-tool",
        description: "Does things.",
        template: "basic",
        targetDir: tempDir,
      });
      expect(result.skillDir).toBe(join(tempDir, "my-tool"));
    });
  });
});
