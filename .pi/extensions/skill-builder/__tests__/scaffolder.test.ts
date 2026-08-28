import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { scaffoldSkill } from "../scaffolder";

let tempDir: string;

const extendedScaffoldCases = [
  {
    template: "with-scripts",
    name: "web-search",
    description: "Searches the web.",
    directory: "scripts",
  },
  {
    template: "with-index",
    name: "api-docs",
    description: "API documentation.",
    directory: "references",
  },
] as const;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "skill-scaffolder-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describeIfEnabled("skill-builder", "Scaffolder", () => {
  describe("basic scaffold", () => {
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

  describe.each(extendedScaffoldCases)("$template scaffold", (scaffoldCase) => {
    it("creates the template directory", () => {
      const result = scaffoldSkill({
        name: scaffoldCase.name,
        description: scaffoldCase.description,
        template: scaffoldCase.template,
        targetDir: tempDir,
      });
      expect(result.success).toBe(true);
      expect(existsSync(join(result.skillDir, scaffoldCase.directory))).toBe(true);
    });

    it("creates a placeholder file", () => {
      const result = scaffoldSkill({
        name: scaffoldCase.name,
        description: scaffoldCase.description,
        template: scaffoldCase.template,
        targetDir: tempDir,
      });
      const prefix = `${scaffoldCase.directory}/`;
      expect(result.filesCreated.some((file) => file.startsWith(prefix))).toBe(true);
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
