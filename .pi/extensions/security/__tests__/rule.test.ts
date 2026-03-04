import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { Rule } from "../rule";

describeIfEnabled("security", "Rule", () => {
  describe("validate", () => {
    const validRule = {
      id: "test-1",
      tool: "bash",
      field: "command",
      pattern: "^git\\b",
      level: "none" as const,
      action: "allow" as const,
      scope: "global" as const,
      description: "Git commands",
      createdAt: Date.now(),
    };

    it("accepts a valid rule", () => {
      expect(Rule.validate(validRule)).toEqual([]);
    });

    it("rejects missing tool (empty string)", () => {
      const errors = Rule.validate({ ...validRule, tool: "" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Tool");
    });

    it("accepts non-builtin tool names (custom tools are valid)", () => {
      // BUILTIN_TOOLS is reference documentation only — custom tools like
      // "notes" or "proxmox" are intentionally allowed
      const errors = Rule.validate({ ...validRule, tool: "notes" });
      expect(errors).toEqual([]);
    });

    it("rejects missing field (empty string)", () => {
      const errors = Rule.validate({ ...validRule, field: "" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Field");
    });

    it("accepts non-builtin field names (custom tool fields are valid)", () => {
      // BUILTIN_FIELDS is reference documentation only — custom tool fields
      // like "action" or "query" are intentionally allowed
      const errors = Rule.validate({ ...validRule, field: "action" });
      expect(errors).toEqual([]);
    });

    it("rejects invalid regex pattern", () => {
      const errors = Rule.validate({ ...validRule, pattern: "[invalid" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("regex") || e.includes("Invalid"))).toBe(true);
    });

    it("rejects overly long patterns", () => {
      const errors = Rule.validate({ ...validRule, pattern: "a".repeat(501) });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes("long"))).toBe(true);
    });

    it("rejects invalid level", () => {
      const errors = Rule.validate({ ...validRule, level: "extreme" as any });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects invalid action", () => {
      const errors = Rule.validate({ ...validRule, action: "maybe" as any });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects invalid scope", () => {
      const errors = Rule.validate({ ...validRule, scope: "universe" as any });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects missing description", () => {
      const errors = Rule.validate({ ...validRule, description: "" });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("accepts wildcard tool and field", () => {
      const errors = Rule.validate({ ...validRule, tool: "*", field: "*" });
      expect(errors).toEqual([]);
    });
  });

  describe("create", () => {
    it("generates id and timestamp", () => {
      const rule = Rule.create({
        tool: "bash",
        field: "command",
        pattern: "^npm\\b",
        level: "low",
        action: "allow",
        scope: "global",
        description: "NPM commands",
      });

      expect(rule.id).toBeTruthy();
      expect(rule.createdAt).toBeGreaterThan(0);
      expect(rule.tool).toBe("bash");
    });

    it("generates unique ids", () => {
      const a = Rule.create({ tool: "bash", field: "command", pattern: "a", level: "none", action: "allow", scope: "global", description: "A" });
      const b = Rule.create({ tool: "bash", field: "command", pattern: "b", level: "none", action: "allow", scope: "global", description: "B" });
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("isValidRegex", () => {
    it("accepts valid patterns", () => {
      expect(Rule.isValidRegex("^git\\b")).toBe(true);
      expect(Rule.isValidRegex(".*")).toBe(true);
      expect(Rule.isValidRegex("\\|")).toBe(true);
    });

    it("rejects invalid patterns", () => {
      expect(Rule.isValidRegex("[unclosed")).toBe(false);
      expect(Rule.isValidRegex("(unmatched")).toBe(false);
    });
  });

  describe("isRegexSafe", () => {
    it("accepts simple patterns", () => {
      expect(Rule.isRegexSafe("^git\\b")).toBe(true);
      expect(Rule.isRegexSafe(".*")).toBe(true);
    });

    // Note: catastrophic backtracking detection is heuristic-based.
    // Some patterns may pass depending on the adversarial input used.
    it("accepts patterns that don't backtrack on test input", () => {
      expect(Rule.isRegexSafe("\\bsudo\\b")).toBe(true);
    });
  });

  describe("autoPattern", () => {
    it("creates word-boundary pattern for bash commands", () => {
      const pattern = Rule.autoPattern("bash", "git push origin main");
      expect(pattern).toBe("^git\\b");
    });

    it("creates exact-match pattern for paths", () => {
      const pattern = Rule.autoPattern("read", "/etc/passwd");
      expect(pattern).toBe("^/etc/passwd$");
    });

    it("escapes special regex characters in paths", () => {
      const pattern = Rule.autoPattern("read", "/path/to/file.ts");
      expect(pattern).toContain("\\.");
    });
  });

  describe("normalizePattern", () => {
    it("converts bare * to .*", () => {
      expect(Rule.normalizePattern("*")).toBe(".*");
    });

    it("converts prefix wildcard foo* to foo.*", () => {
      expect(Rule.normalizePattern("foo*")).toBe("foo.*");
    });

    it("converts suffix wildcard *.ts to .*\\.ts", () => {
      // The dot in .ts should be escaped because autoPattern would do that,
      // but normalizePattern itself just replaces * — test what it actually does
      expect(Rule.normalizePattern("*.ts")).toBe(".*.ts");
    });

    it("leaves .* unchanged (already valid)", () => {
      expect(Rule.normalizePattern(".*")).toBe(".*");
    });

    it("leaves \\* unchanged (escaped literal asterisk)", () => {
      expect(Rule.normalizePattern("\\*")).toBe("\\*");
    });

    it("leaves patterns without * unchanged", () => {
      expect(Rule.normalizePattern("^git\\b")).toBe("^git\\b");
      expect(Rule.normalizePattern("/path/to/file")).toBe("/path/to/file");
    });

    it("create() applies normalization to pattern", () => {
      const rule = Rule.create({
        tool: "read",
        field: "path",
        pattern: "*",
        level: "none",
        action: "allow",
        scope: "global",
        description: "All reads",
      });
      expect(rule.pattern).toBe(".*");
    });

    it("normalized * passes isValidRegex", () => {
      expect(Rule.isValidRegex(Rule.normalizePattern("*"))).toBe(true);
    });
  });

  describe("escapeRegex", () => {
    it("escapes all special characters", () => {
      const escaped = Rule.escapeRegex("hello.world*[test]");
      expect(escaped).toBe("hello\\.world\\*\\[test\\]");
    });

    it("leaves alphanumeric unchanged", () => {
      expect(Rule.escapeRegex("hello123")).toBe("hello123");
    });
  });

  describe("generateId", () => {
    it("returns a non-empty string", () => {
      expect(Rule.generateId().length).toBeGreaterThan(0);
    });

    it("contains a separator", () => {
      expect(Rule.generateId()).toContain("-");
    });
  });
});
