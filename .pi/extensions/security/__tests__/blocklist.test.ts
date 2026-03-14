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

describe("blocklist", () => {
  // ── rm-recursive ─────────────────────────────────────────────────────────

  describe("rm-recursive", () => {
    it("blocks rm -rf", () => {
      expect(blocked("bash", "command", "rm -rf /tmp/test")).toBe(true);
    });

    it("blocks rm -fr (flag order reversed)", () => {
      expect(blocked("bash", "command", "rm -fr /tmp/test")).toBe(true);
    });

    it("blocks rm -Rf (uppercase R)", () => {
      expect(blocked("bash", "command", "rm -Rf /tmp/test")).toBe(true);
    });

    it("blocks rm -r (recursive without force)", () => {
      expect(blocked("bash", "command", "rm -r /tmp/test")).toBe(true);
    });

    it("blocks rm --recursive", () => {
      expect(blocked("bash", "command", "rm --recursive /tmp/test")).toBe(true);
    });

    it("blocks rm with combined flags containing r (e.g. -rfv)", () => {
      expect(blocked("bash", "command", "rm -rfv /tmp")).toBe(true);
    });

    it("does NOT block plain rm of a single file", () => {
      expect(blocked("bash", "command", "rm file.txt")).toBe(false);
    });

    it("does NOT block rm -f (force without recursive)", () => {
      expect(blocked("bash", "command", "rm -f file.txt")).toBe(false);
    });

    it("does NOT block rm -r/ (invalid flag — no space after r)", () => {
      expect(blocked("bash", "command", "rm -r/")).toBe(false);
    });

    it("does NOT block rmdir", () => {
      expect(blocked("bash", "command", "rmdir empty_dir")).toBe(false);
    });

    it("does NOT fire on write tool", () => {
      expect(blocked("write", "command", "rm -rf /")).toBe(false);
    });
  });

  // ── write-shell-config ───────────────────────────────────────────────────

  describe("write-shell-config", () => {
    it("blocks write to .bashrc", () => {
      expect(blocked("write", "path", "/home/user/.bashrc")).toBe(true);
    });

    it("blocks edit of .zshrc", () => {
      expect(blocked("edit", "path", "/root/.zshrc")).toBe(true);
    });

    it("blocks .profile", () => {
      expect(blocked("write", "path", "/home/user/.profile")).toBe(true);
    });

    it("blocks .bash_profile", () => {
      expect(blocked("write", "path", "/home/user/.bash_profile")).toBe(true);
    });

    it("blocks .zshenv", () => {
      expect(blocked("write", "path", "/home/user/.zshenv")).toBe(true);
    });

    it("blocks .bash_logout", () => {
      expect(blocked("write", "path", "/home/user/.bash_logout")).toBe(true);
    });

    it("does NOT block writing to a file named profile.ts", () => {
      expect(blocked("write", "path", "src/profile.ts")).toBe(false);
    });

    it("does NOT fire on bash tool", () => {
      expect(blocked("bash", "path", "/home/user/.bashrc")).toBe(false);
    });
  });

  // ── write-cron ───────────────────────────────────────────────────────────

  describe("write-cron", () => {
    it("blocks /etc/cron.d paths", () => {
      expect(blocked("write", "path", "/etc/cron.d/myjob")).toBe(true);
    });

    it("blocks /var/spool/cron paths", () => {
      expect(blocked("write", "path", "/var/spool/cron/crontabs/user")).toBe(true);
    });

    it("blocks edit of crontab path", () => {
      expect(blocked("edit", "path", "/etc/crontab")).toBe(true);
    });

    it("does NOT block a file with 'cron' in the content (bash)", () => {
      // Only write/edit path is checked, not bash commands
      expect(blocked("bash", "path", "/etc/cron.d/job")).toBe(false);
    });

    it("does NOT block src/CronScheduler.tsx (false positive regression)", () => {
      expect(blocked("write", "path", "src/CronScheduler.tsx")).toBe(false);
    });

    it("does NOT block docs/cron-usage.md (false positive regression)", () => {
      expect(blocked("write", "path", "docs/cron-usage.md")).toBe(false);
    });

    it("does NOT block lib/acronym.ts (false positive regression)", () => {
      expect(blocked("write", "path", "lib/acronym.ts")).toBe(false);
    });
  });

  // ── write-systemd ────────────────────────────────────────────────────────

  describe("write-systemd", () => {
    it("blocks writing a systemd unit file", () => {
      expect(blocked("write", "path", "/etc/systemd/system/myservice.service")).toBe(true);
    });

    it("blocks edit of a systemd drop-in", () => {
      expect(blocked("edit", "path", "/lib/systemd/system/docker.service")).toBe(true);
    });

    it("blocks /run/systemd paths", () => {
      expect(blocked("write", "path", "/run/systemd/system/override.conf")).toBe(true);
    });

    it("blocks user-level ~/.config/systemd/user/ units", () => {
      expect(blocked("write", "path", "/home/user/.config/systemd/user/myservice.service")).toBe(true);
    });

    it("does NOT block src/systemd-parser.ts (false positive regression)", () => {
      expect(blocked("write", "path", "src/systemd-parser.ts")).toBe(false);
    });

    it("does NOT block docs/systemd-notes.md (false positive regression)", () => {
      expect(blocked("write", "path", "docs/systemd-notes.md")).toBe(false);
    });
  });

  // ── write-git-hook ───────────────────────────────────────────────────────

  describe("write-git-hook", () => {
    it("blocks writing a pre-commit hook", () => {
      expect(blocked("write", "path", ".git/hooks/pre-commit")).toBe(true);
    });

    it("blocks writing a post-merge hook", () => {
      expect(blocked("edit", "path", "/repo/.git/hooks/post-merge")).toBe(true);
    });

    it("does NOT block writing to .git/config", () => {
      expect(blocked("write", "path", ".git/config")).toBe(false);
    });
  });

  // ── write-ssh-authorized-keys ────────────────────────────────────────────

  describe("write-ssh-authorized-keys", () => {
    it("blocks writing to authorized_keys", () => {
      expect(blocked("write", "path", "/home/user/.ssh/authorized_keys")).toBe(true);
    });

    it("blocks edit of authorized_keys", () => {
      expect(blocked("edit", "path", "/root/.ssh/authorized_keys")).toBe(true);
    });

    it("blocks authorized_keys2 (legacy variant)", () => {
      expect(blocked("write", "path", "/home/user/.ssh/authorized_keys2")).toBe(true);
    });

    it("does NOT block .ssh/known_hosts", () => {
      expect(blocked("write", "path", "/home/user/.ssh/known_hosts")).toBe(false);
    });

    it("does NOT block .ssh/id_rsa.pub", () => {
      expect(blocked("write", "path", "/home/user/.ssh/id_rsa.pub")).toBe(false);
    });
  });

  // ── write-etc ────────────────────────────────────────────────────────────

  describe("write-etc", () => {
    it("blocks writing to /etc/hosts", () => {
      expect(blocked("write", "path", "/etc/hosts")).toBe(true);
    });

    it("blocks writing to /etc/passwd", () => {
      expect(blocked("write", "path", "/etc/passwd")).toBe(true);
    });

    it("blocks edit of /etc/nginx/nginx.conf", () => {
      expect(blocked("edit", "path", "/etc/nginx/nginx.conf")).toBe(true);
    });

    it("blocks bare /etc path (no trailing slash)", () => {
      expect(blocked("write", "path", "/etc")).toBe(true);
    });

    it("does NOT block paths that merely contain 'etc' not at root", () => {
      expect(blocked("write", "path", "/home/user/etc/config.txt")).toBe(false);
    });

    it("does NOT block relative paths containing etc", () => {
      expect(blocked("write", "path", "project/etc/settings.json")).toBe(false);
    });
  });

  // ── Tool scope isolation ─────────────────────────────────────────────────

  describe("tool scope", () => {
    it("write-* entries do not fire on the bash tool", () => {
      expect(blocked("bash", "path", "/etc/passwd")).toBe(false);
      expect(blocked("bash", "path", ".git/hooks/pre-commit")).toBe(false);
    });

    it("rm-recursive does not fire on write or edit tools", () => {
      expect(blocked("write", "command", "rm -rf /")).toBe(false);
      expect(blocked("edit", "command", "rm -rf /")).toBe(false);
    });

    it("custom tools not in any entry are never blocked", () => {
      expect(blocked("dev-tools", "command", "rm -rf /")).toBe(false);
      expect(blocked("tmux", "path", "/etc/hosts")).toBe(false);
    });
  });
});
