import { describe, expect, it } from "vitest";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { renderTemplate, getTemplateTypes } from "../templates";

const directoryTemplateCases = [
  {
    template: "with-scripts",
    name: "web-search",
    description: "Searches the web via Brave API.",
    directory: "scripts",
  },
  {
    template: "with-index",
    name: "api-docs",
    description: "API documentation for the project.",
    directory: "references",
  },
] as const;

describeIfEnabled("skill-builder", "Templates", () => {
  describe("getTemplateTypes", () => {
    it("returns all available template types", () => {
      const types = getTemplateTypes();
      expect(types).toContain("basic");
      expect(types).toContain("with-scripts");
      expect(types).toContain("with-index");
    });
  });

  describe("basic template", () => {
    it("produces valid SKILL.md with frontmatter", () => {
      const result = renderTemplate({
        name: "my-tool",
        description: "Extracts data from CSV files. Use when working with tabular data.",
        template: "basic",
      });
      expect(result.files["SKILL.md"]).toBeDefined();
      expect(result.files["SKILL.md"]).toContain("---");
      expect(result.files["SKILL.md"]).toContain("name: my-tool");
      expect(result.files["SKILL.md"]).toContain("description:");
    });

    it("includes the name and description in frontmatter", () => {
      const result = renderTemplate({
        name: "csv-parser",
        description: "Parses CSV files into structured data.",
        template: "basic",
      });
      expect(result.files["SKILL.md"]).toContain("name: csv-parser");
      expect(result.files["SKILL.md"]).toContain("Parses CSV files");
    });

    it("includes a body with usage section", () => {
      const result = renderTemplate({
        name: "csv-parser",
        description: "Parses CSV files.",
        template: "basic",
      });
      const content = result.files["SKILL.md"];
      expect(content).toContain("# ");
      expect(content).toContain("## ");
    });

    it("only produces SKILL.md for basic template", () => {
      const result = renderTemplate({
        name: "simple",
        description: "A simple skill.",
        template: "basic",
      });
      expect(Object.keys(result.files)).toEqual(["SKILL.md"]);
    });
  });

  describe("directory templates", () => {
    it.each(directoryTemplateCases)(
      "$template produces SKILL.md and a $directory directory entry",
      (templateCase) => {
        const result = renderTemplate({
          name: templateCase.name,
          description: templateCase.description,
          template: templateCase.template,
        });
        expect(result.files["SKILL.md"]).toBeDefined();
        const prefix = `${templateCase.directory}/`;
        expect(Object.keys(result.files).some((file) => file.startsWith(prefix))).toBe(true);
      },
    );
  });

  describe("with-scripts template", () => {
    it("SKILL.md references the scripts directory", () => {
      const result = renderTemplate({
        name: "web-search",
        description: "Searches the web.",
        template: "with-scripts",
      });
      expect(result.files["SKILL.md"]).toContain("scripts/");
    });
  });

  describe("with-index template (compression pattern)", () => {
    it("SKILL.md contains a compressed index section", () => {
      const result = renderTemplate({
        name: "api-docs",
        description: "API documentation.",
        template: "with-index",
      });
      const content = result.files["SKILL.md"];
      // Should contain index-style references, not full embedded docs
      expect(content).toContain("references/");
      expect(content).toMatch(/index|Index/i);
    });

    it("does not repeat the activation description in the body", () => {
      const result = renderTemplate({
        name: "api-docs",
        description: "API documentation.",
        template: "with-index",
      });
      const content = result.files["SKILL.md"];
      expect(content).not.toContain("## When to Use");
      expect(content.match(/API documentation\./g)).toHaveLength(1);
    });

    it("SKILL.md body stays under 8KB", () => {
      const result = renderTemplate({
        name: "api-docs",
        description: "API documentation.",
        template: "with-index",
      });
      const content = result.files["SKILL.md"];
      expect(Buffer.byteLength(content, "utf-8")).toBeLessThan(8192);
    });
  });

  describe("all templates", () => {
    for (const tmpl of ["basic", "with-scripts", "with-index"] as const) {
      it(`${tmpl}: frontmatter name matches input name`, () => {
        const result = renderTemplate({
          name: "test-skill",
          description: "A test skill for validation.",
          template: tmpl,
        });
        expect(result.files["SKILL.md"]).toContain("name: test-skill");
      });

      it(`${tmpl}: description appears in frontmatter`, () => {
        const result = renderTemplate({
          name: "test-skill",
          description: "A test skill for validation.",
          template: tmpl,
        });
        expect(result.files["SKILL.md"]).toContain("A test skill for validation.");
      });
    }
  });
});
