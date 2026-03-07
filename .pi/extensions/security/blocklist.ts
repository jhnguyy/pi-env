/**
 * Hard-block patterns for the security extension.
 *
 * Criteria for inclusion: the operation is either unrecoverable (data loss)
 * or writes to a path that executes beyond the current session (shell configs,
 * cron, systemd, git hooks, SSH access control).
 *
 * No prompts. No reviews. Block means block.
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
    pattern: /cron/i,
    reason: "Cron path writes blocked — edit directly if needed",
  },
  {
    id: "write-systemd",
    tools: ["write", "edit"],
    field: "path",
    pattern: /systemd/i,
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
