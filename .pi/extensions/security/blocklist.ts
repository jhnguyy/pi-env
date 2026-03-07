/**
 * Hard-block patterns for the security extension.
 *
 * Criteria for inclusion: the operation is either unrecoverable (data loss)
 * or writes to a path that executes beyond the current session (shell configs,
 * cron, systemd, git hooks, SSH access control).
 *
 * No prompts. No reviews. Block means block.
 *
 * Scope: write and edit tools only.
 * The bash tool is the trust boundary — if the agent has bash, it can write
 * anywhere via redirects, heredocs, tee, python one-liners, etc. Trying to
 * pattern-match bash redirects to blocked paths is whack-a-mole that was
 * tried in the previous version of this extension and removed for being
 * fragile theater. These write/edit blocks are defense-in-depth against the
 * structured file tools, not a filesystem ACL.
 */

export interface BlockEntry {
  id: string;
  /** Tool names this entry applies to. */
  tools: string[];
  /** Input field to test against the pattern. */
  field: string;
  pattern: RegExp;
  reason: string;
}

export const BLOCKLIST: BlockEntry[] = [
  // ── Destructive ───────────────────────────────────────────────────────────
  // Recursive deletion is unrecoverable. Hard stop regardless of target path.
  {
    id: "rm-recursive",
    tools: ["bash"],
    field: "command",
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*(\s|$)|--recursive\b)/i,
    reason: "rm with recursive flag blocked — use targeted deletions",
  },

  // ── Shell configs (execute on every shell start) ──────────────────────────
  {
    id: "write-shell-config",
    tools: ["write", "edit"],
    field: "path",
    pattern: /\.(bashrc|bash_profile|bash_logout|profile|zshrc|zprofile|zshenv)$/,
    reason: "Shell config writes blocked — edit the file directly if needed",
  },

  // ── Scheduled/persistent execution paths ─────────────────────────────────
  {
    id: "write-cron",
    tools: ["write", "edit"],
    field: "path",
    // Anchored to system cron locations — avoids false positives on source
    // files like src/CronScheduler.tsx or docs/cron-usage.md.
    pattern: /^\/(etc|var\/spool)\/(cron|at)/,
    reason: "Cron path writes blocked — edit directly if needed",
  },
  {
    id: "write-systemd",
    tools: ["write", "edit"],
    field: "path",
    // Anchored to system and user unit directories — avoids false positives on
    // source files like src/systemd-parser.ts or docs/systemd-notes.md.
    // Covers both system paths (/etc/systemd, /lib/systemd, ...) and
    // user-scoped units (~/.config/systemd/user/).
    pattern: /^\/(etc|lib|usr\/lib|run)\/systemd\/|\/\.config\/systemd\//,
    reason: "Systemd unit writes blocked — edit directly if needed",
  },
  {
    id: "write-git-hook",
    tools: ["write", "edit"],
    field: "path",
    pattern: /\.git\/hooks\//,
    reason: "Git hook writes blocked — edit directly if needed",
  },

  // ── Remote access control ─────────────────────────────────────────────────
  {
    id: "write-ssh-authorized-keys",
    tools: ["write", "edit"],
    field: "path",
    pattern: /\.ssh\/authorized_keys2?$/,
    reason: "SSH authorized_keys writes blocked — edit directly if needed",
  },

  // ── System config directory ───────────────────────────────────────────────
  {
    id: "write-etc",
    tools: ["write", "edit"],
    field: "path",
    pattern: /^\/etc(\/|$)/,
    reason: "/etc writes blocked — edit directly if needed",
  },
];
