import { describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { Rule } from "../rule";
import { PatternMatcher } from "../pattern-matcher";

const matcher = new PatternMatcher();

function makeRule(overrides: Partial<ReturnType<typeof Rule.create>> = {}) {
  return Rule.create({
    tool: "bash",
    field: "command",
    pattern: "^test\\b",
    level: "none",
    action: "allow",
    scope: "global",
    description: "Test rule",
    ...overrides,
  });
}

describeIfEnabled("security", "PatternMatcher", () => {
  describe("findMatch", () => {
    it("matches a simple bash command pattern", () => {
      const rules = [makeRule({ pattern: "^git\\b" })];
      const result = matcher.findMatch("bash", { command: "git status" }, rules);
      expect(result).not.toBeNull();
      expect(result?.pattern).toBe("^git\\b");
    });

    it("returns null when no rules match", () => {
      const rules = [makeRule({ pattern: "^git\\b" })];
      const result = matcher.findMatch("bash", { command: "npm install" }, rules);
      expect(result).toBeNull();
    });

    it("matches path patterns for read tool", () => {
      const rules = [makeRule({ tool: "read", field: "path", pattern: "^/mnt/" })];
      const result = matcher.findMatch("read", { path: "/mnt/data/file.txt" }, rules);
      expect(result).not.toBeNull();
    });

    it("does not match wrong tool", () => {
      const rules = [makeRule({ tool: "bash", pattern: "^git\\b" })];
      const result = matcher.findMatch("read", { path: "git" }, rules);
      expect(result).toBeNull();
    });

    it("matches wildcard tool", () => {
      const rules = [makeRule({ tool: "*", field: "*", pattern: "test" })];
      const resultBash = matcher.findMatch("bash", { command: "echo test" }, rules);
      const resultRead = matcher.findMatch("read", { path: "/test/file" }, rules);
      expect(resultBash).not.toBeNull();
      expect(resultRead).not.toBeNull();
    });

    it("returns first matching rule (session before global)", () => {
      const rules = [
        makeRule({ scope: "session", pattern: "^git\\b", action: "deny", description: "session deny" }),
        makeRule({ scope: "global", pattern: "^git\\b", action: "allow", description: "global allow" }),
      ];
      const result = matcher.findMatch("bash", { command: "git push" }, rules);
      expect(result?.description).toBe("session deny");
    });
  });

  // ─── Priority Queue Ordering ────────────────────────────────────

  describe("priority queue ordering", () => {
    describe("action priority (deny > review > allow)", () => {
      it("deny beats allow regardless of list order — allow first", () => {
        const rules = [
          makeRule({ action: "allow", pattern: "cat .*",  description: "broad allow" }),
          makeRule({ action: "deny",  pattern: "\\.env",  description: "env deny" }),
        ];
        const result = matcher.findMatch("bash", { command: "cat .env" }, rules);
        expect(result?.description).toBe("env deny");
      });

      it("deny beats allow regardless of list order — deny first", () => {
        const rules = [
          makeRule({ action: "deny",  pattern: "\\.env",  description: "env deny" }),
          makeRule({ action: "allow", pattern: "cat .*",  description: "broad allow" }),
        ];
        const result = matcher.findMatch("bash", { command: "cat .env" }, rules);
        expect(result?.description).toBe("env deny");
      });

      it("deny beats review regardless of list order", () => {
        const rules = [
          makeRule({ action: "review", pattern: ".*",     description: "review all" }),
          makeRule({ action: "deny",   pattern: "\\.env", description: "env deny" }),
        ];
        const result = matcher.findMatch("bash", { command: "cat .env" }, rules);
        expect(result?.description).toBe("env deny");
      });

      it("review beats allow regardless of list order", () => {
        const rules = [
          makeRule({ action: "allow",  pattern: ".*",       description: "broad allow" }),
          makeRule({ action: "review", pattern: "curl .*",  description: "review curl" }),
        ];
        const result = matcher.findMatch("bash", { command: "curl https://example.com" }, rules);
        expect(result?.description).toBe("review curl");
      });

      it("falls through to allow when no deny or review matches", () => {
        const rules = [
          makeRule({ action: "deny",  pattern: "\\.env",  description: "env deny" }),
          makeRule({ action: "allow", pattern: "^git\\b", description: "git allow" }),
        ];
        const result = matcher.findMatch("bash", { command: "git status" }, rules);
        expect(result?.description).toBe("git allow");
      });
    });

    describe("scope priority (session > global) within same action", () => {
      it("session deny beats global deny", () => {
        const rules = [
          makeRule({ scope: "global",  action: "deny", pattern: "^git\\b", description: "global deny" }),
          makeRule({ scope: "session", action: "deny", pattern: "^git\\b", description: "session deny" }),
        ];
        const result = matcher.findMatch("bash", { command: "git push" }, rules);
        expect(result?.description).toBe("session deny");
      });

      it("session allow beats global allow", () => {
        const rules = [
          makeRule({ scope: "global",  action: "allow", pattern: "^git\\b", description: "global allow" }),
          makeRule({ scope: "session", action: "allow", pattern: "^git\\b", description: "session allow" }),
        ];
        const result = matcher.findMatch("bash", { command: "git status" }, rules);
        expect(result?.description).toBe("session allow");
      });

      it("session allow loses to global deny (action beats scope)", () => {
        const rules = [
          makeRule({ scope: "global",  action: "deny",  pattern: "\\.env", description: "global deny" }),
          makeRule({ scope: "session", action: "allow", pattern: ".*",     description: "session allow all" }),
        ];
        const result = matcher.findMatch("bash", { command: "cat .env" }, rules);
        expect(result?.description).toBe("global deny");
      });

      it("session deny beats global allow (both action and scope agree)", () => {
        const rules = [
          makeRule({ scope: "global",  action: "allow", pattern: ".*",     description: "global allow all" }),
          makeRule({ scope: "session", action: "deny",  pattern: "\\.env", description: "session deny" }),
        ];
        const result = matcher.findMatch("bash", { command: "cat .env" }, rules);
        expect(result?.description).toBe("session deny");
      });
    });
  });

  describe("findMatch (continued)", () => {

    it("handles invalid regex gracefully", () => {
      const rules = [
        { ...makeRule({ pattern: "[invalid" }), pattern: "[invalid" } as any,
        makeRule({ pattern: "^git\\b" }),
      ];
      // Should skip invalid and match the valid one
      const result = matcher.findMatch("bash", { command: "git status" }, rules);
      expect(result?.pattern).toBe("^git\\b");
    });

    it("matches using field override", () => {
      const rules = [makeRule({ tool: "write", field: "content", pattern: "DROP TABLE" })];
      const result = matcher.findMatch("write", { path: "safe.sql", content: "DROP TABLE users" }, rules);
      expect(result).not.toBeNull();
    });

    it("returns null for empty input field", () => {
      const rules = [makeRule({ pattern: "^git\\b" })];
      const result = matcher.findMatch("bash", { command: "" }, rules);
      expect(result).toBeNull();
    });

    it("returns null for missing input field", () => {
      const rules = [makeRule({ pattern: "^git\\b" })];
      const result = matcher.findMatch("bash", {}, rules);
      expect(result).toBeNull();
    });
  });

  describe("regex caching", () => {
    it("reuses compiled regex across calls", () => {
      const rules = [makeRule({ pattern: "^git\\b" })];

      // Call twice — should use cache on second call
      matcher.findMatch("bash", { command: "git status" }, rules);
      const result = matcher.findMatch("bash", { command: "git push" }, rules);
      expect(result).not.toBeNull();
    });

    it("clearCache allows re-compilation", () => {
      const rules = [makeRule({ pattern: "^git\\b" })];
      matcher.findMatch("bash", { command: "git status" }, rules);

      matcher.clearCache();
      const result = matcher.findMatch("bash", { command: "git push" }, rules);
      expect(result).not.toBeNull();
    });
  });
});
