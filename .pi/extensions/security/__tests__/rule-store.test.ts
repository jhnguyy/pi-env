import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { describeIfEnabled } from "../../__tests__/test-utils";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Rule } from "../rule";
import { RuleStore } from "../rule-store";

let tempDir: string;
let filePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "permissions-test-"));
  filePath = join(tempDir, "permissions.json");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

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

describeIfEnabled("security", "RuleStore", () => {
  describe("initialization", () => {
    it("creates permissions.json if not exists", () => {
      new RuleStore(filePath);
      expect(existsSync(filePath)).toBe(true);
    });

    it("creates with empty JSON object", () => {
      new RuleStore(filePath);
      const content = readFileSync(filePath, "utf-8");
      expect(content).toBe("{}");
    });

    it("loads existing rules", () => {
      const config = {
        version: 1,
        rules: [makeRule()],
      };
      writeFileSync(filePath, JSON.stringify(config));

      const store = new RuleStore(filePath);
      expect(store.getGlobalRules().length).toBe(1);
    });

    it("handles empty object {} gracefully", () => {
      writeFileSync(filePath, "{}");
      const store = new RuleStore(filePath);
      expect(store.getGlobalRules()).toEqual([]);
    });

    it("skips invalid rules on load", () => {
      const config = {
        version: 1,
        rules: [
          makeRule(),
          { id: "bad", tool: "invalid", field: "x", pattern: "[bad", level: "none", action: "allow", scope: "global", description: "", createdAt: 0 },
        ],
      };
      writeFileSync(filePath, JSON.stringify(config));

      const store = new RuleStore(filePath);
      expect(store.getGlobalRules().length).toBe(1);
    });
  });

  describe("addRule", () => {
    it("adds a rule and persists to disk", () => {
      const store = new RuleStore(filePath);
      const rule = makeRule();
      store.addRule(rule);

      // Verify in memory
      expect(store.getGlobalRules().length).toBe(1);

      // Verify on disk
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(raw.rules.length).toBe(1);
      expect(raw.rules[0].id).toBe(rule.id);
    });

    it("rejects invalid rules", () => {
      const store = new RuleStore(filePath);
      const badRule = makeRule({ pattern: "[invalid" });
      expect(() => store.addRule(badRule)).toThrow();
    });
  });

  describe("removeRule", () => {
    it("removes a rule by id", () => {
      const store = new RuleStore(filePath);
      const rule = makeRule();
      store.addRule(rule);
      expect(store.getGlobalRules().length).toBe(1);

      const removed = store.removeRule(rule.id);
      expect(removed).toBe(true);
      expect(store.getGlobalRules().length).toBe(0);
    });

    it("returns false for non-existent id", () => {
      const store = new RuleStore(filePath);
      expect(store.removeRule("nonexistent")).toBe(false);
    });
  });

  describe("session rules", () => {
    it("stores session rules in memory", () => {
      const store = new RuleStore(filePath);
      const rule = makeRule({ scope: "session" });
      store.addSessionRule(rule);

      expect(store.getAllRules().length).toBe(1);
      // NOT persisted to disk
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(raw.rules?.length ?? 0).toBe(0);
    });

    it("setSessionRules replaces all session rules", () => {
      const store = new RuleStore(filePath);
      store.addSessionRule(makeRule({ scope: "session" }));
      store.addSessionRule(makeRule({ scope: "session" }));
      expect(store.getAllRules().length).toBe(2);

      store.setSessionRules([makeRule({ scope: "session" })]);
      expect(store.getAllRules().length).toBe(1);
    });
  });

  describe("getAllRules", () => {
    it("returns session rules before global rules", () => {
      const store = new RuleStore(filePath);
      const global = makeRule({ description: "global", scope: "global" });
      const session = makeRule({ description: "session", scope: "session" });
      store.addRule(global);
      store.addSessionRule(session);

      const all = store.getAllRules();
      expect(all.length).toBe(2);
      expect(all[0].description).toBe("session");
      expect(all[1].description).toBe("global");
    });
  });

  describe("cross-instance file sharing", () => {
    it("detects file changes from another instance", () => {
      const store1 = new RuleStore(filePath);
      const store2 = new RuleStore(filePath);

      // store1 adds a rule
      store1.addRule(makeRule({ description: "from store1" }));

      // store2 should see it on next read (after mtime change)
      const rules = store2.getGlobalRules();
      expect(rules.length).toBe(1);
      expect(rules[0].description).toBe("from store1");
    });
  });

  describe("reload", () => {
    it("reloads rules from disk", () => {
      const store = new RuleStore(filePath);
      expect(store.getGlobalRules().length).toBe(0);

      // External write
      const config = { version: 1, rules: [makeRule()] };
      writeFileSync(filePath, JSON.stringify(config));

      store.reload();
      expect(store.getGlobalRules().length).toBe(1);
    });
  });

  describe("defaultMode", () => {
    it("getDefaultMode() returns 'default' when not in file", () => {
      const store = new RuleStore(filePath);
      expect(store.getDefaultMode()).toBe("default");
    });

    it("loads defaultMode from file when present", () => {
      writeFileSync(filePath, JSON.stringify({ version: 1, defaultMode: "permissive", rules: [] }));
      const store = new RuleStore(filePath);
      expect(store.getDefaultMode()).toBe("permissive");
    });

    it("ignores invalid defaultMode values", () => {
      writeFileSync(filePath, JSON.stringify({ version: 1, defaultMode: "invalid", rules: [] }));
      const store = new RuleStore(filePath);
      expect(store.getDefaultMode()).toBe("default");
    });

    it("persists non-default defaultMode on saveToDisk (via addRule)", () => {
      writeFileSync(filePath, JSON.stringify({ version: 1, defaultMode: "permissive", rules: [] }));
      const store = new RuleStore(filePath);
      store.addRule(makeRule()); // triggers saveToDisk
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(raw.defaultMode).toBe("permissive");
    });

    it("omits defaultMode from disk when it is 'default'", () => {
      const store = new RuleStore(filePath);
      store.addRule(makeRule());
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(raw.defaultMode).toBeUndefined();
    });

    it("survives reload", () => {
      writeFileSync(filePath, JSON.stringify({ version: 1, defaultMode: "permissive", rules: [] }));
      const store = new RuleStore(filePath);
      store.reload();
      expect(store.getDefaultMode()).toBe("permissive");
    });
  });

  describe("session mode", () => {
    it("defaults to 'default' mode", () => {
      const store = new RuleStore(filePath);
      expect(store.getSessionMode()).toBe("default");
    });

    it("can be set to permissive", () => {
      const store = new RuleStore(filePath);
      store.setSessionMode("permissive");
      expect(store.getSessionMode()).toBe("permissive");
    });

    it("can be set to lockdown", () => {
      const store = new RuleStore(filePath);
      store.setSessionMode("lockdown");
      expect(store.getSessionMode()).toBe("lockdown");
    });

    it("can be reset back to default", () => {
      const store = new RuleStore(filePath);
      store.setSessionMode("permissive");
      store.setSessionMode("default");
      expect(store.getSessionMode()).toBe("default");
    });

    it("is independent of global rules (not persisted to disk)", () => {
      const store = new RuleStore(filePath);
      store.setSessionMode("lockdown");

      // Re-loading from disk must NOT affect the mode (it's session-only)
      store.reload();
      // After reload, mode resets to default (session state is not on disk)
      // — this documents the expected behaviour: reload() only touches global rules
      // The caller (index.ts reconstruct) is responsible for restoring mode from session entries
      expect(store.getSessionMode()).toBe("lockdown"); // in-memory, not touched by reload
    });

    it("setSessionMode does not affect global rules on disk", () => {
      const store = new RuleStore(filePath);
      store.addRule(makeRule());
      store.setSessionMode("permissive");

      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(raw.rules.length).toBe(1);
      expect(raw.mode).toBeUndefined(); // mode must NOT leak into the file
    });
  });
});
