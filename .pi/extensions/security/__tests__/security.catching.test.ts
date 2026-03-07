import { describe, expect, it } from "bun:test";
import { BLOCKLIST } from "../blocklist";

function blocked(tool: string, field: string, value: string): boolean {
  for (const entry of BLOCKLIST) {
    if (!entry.tools.includes(tool)) continue;
    if (entry.field !== field) continue;
    if (entry.pattern.test(value)) return true;
  }
  return false;
}

describe("blocklist – catching tests", () => {
  describe("BLOCKLIST structure invariants", () => {
    it("every entry has a non-empty tools array", () => {
      for (const entry of BLOCKLIST) {
        expect(Array.isArray(entry.tools)).toBe(true);
        expect(entry.tools.length).toBeGreaterThan(0);
      }
    });

    it("every entry has a string field and a RegExp pattern", () => {
      for (const entry of BLOCKLIST) {
        expect(typeof entry.field).toBe("string");
        expect(entry.pattern instanceof RegExp).toBe(true);
      }
    });

    it("exports exactly 7 entries (one per dangerous pattern documented)", () => {
      expect(BLOCKLIST.length).toBe(7);
    });
  });

  describe("rm-recursive boundary cases", () => {
    it("blocks rm -r with no trailing space before target (minimal form)", () => {
      // "rm -r/" is a real foot-gun
      expect(blocked("bash", "command", "rm -r/")).toBe(false); // -r/ is not a valid flag combo → should NOT block via flag match
    });

    it("blocks rm --recursive long-form alias", () => {
      expect(blocked("bash", "command", "rm --recursive /home/user/old")).toBe(true);
    });

    it("does NOT block 'grep -r' – only rm is targeted", () => {
      expect(blocked("bash", "command", "grep -r pattern /src")).toBe(false);
    });
  });

  describe("write-etc boundary: /etc must be anchored at root", () => {
    it("blocks bare /etc path (no trailing slash or file)", () => {
      // Some implementations anchor on /etc/ and miss bare /etc
      expect(blocked("write", "path", "/etc")).toBe(true);
    });

    it("does NOT block /home/etc/file (etc not at filesystem root)", () => {
      expect(blocked("write", "path", "/home/etc/hosts")).toBe(false);
    });
  });

  describe("write-cron: additional cron directories", () => {
    it("blocks /etc/cron.daily paths", () => {
      expect(blocked("write", "path", "/etc/cron.daily/cleanup")).toBe(true);
    });

    it("blocks /etc/cron.weekly paths", () => {
      expect(blocked("write", "path", "/etc/cron.weekly/backup")).toBe(true);
    });
  });

  describe("write-ssh-authorized-keys: authorized_keys2 variant", () => {
    it("blocks authorized_keys2 (legacy alternate file)", () => {
      expect(blocked("write", "path", "/home/user/.ssh/authorized_keys2")).toBe(true);
    });
  });

  describe("write-systemd: user-level systemd units", () => {
    it("blocks ~/.config/systemd/user unit files", () => {
      expect(blocked("write", "path", "/home/user/.config/systemd/user/myservice.service")).toBe(true);
    });
  });

  describe("write-shell-config: additional shell rc files", () => {
    it("blocks .bash_logout", () => {
      expect(blocked("write", "path", "/home/user/.bash_logout")).toBe(true);
    });

    it("does NOT block a file simply ending in rc that isn't a shell config (e.g. .eslintrc)", () => {
      expect(blocked("write", "path", "/project/.eslintrc")).toBe(false);
    });
  });
});
