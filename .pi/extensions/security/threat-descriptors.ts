/**
 * Threat pattern definitions — pure data, no logic.
 *
 * Each descriptor declares:
 *   - Which tools it applies to
 *   - Which field to test
 *   - A regex pattern to detect the threat
 *   - The permission level it forces
 *
 * Organized by category for readability. Add new patterns by
 * appending to the relevant section.
 */

import type { ThreatDescriptor } from "./types";

// ─── Bash: Shell Operators ──────────────────────────────────────────
// Any of these chain or embed commands, bypassing single-command checks.

const shellOperators: ThreatDescriptor[] = [
  {
    id: "pipe",
    category: "shell-operator",
    tools: ["bash"],
    field: "command",
    pattern: /(?<!\|)\|(?!\|)/,
    level: "high",
    description: "Pipe operator — data can be exfiltrated or commands chained",
  },
  {
    id: "chain-and",
    category: "shell-operator",
    tools: ["bash"],
    field: "command",
    pattern: /&&/,
    level: "medium",
    description: "AND chaining (&&) — runs next command on success",
  },
  {
    id: "chain-or",
    category: "shell-operator",
    tools: ["bash"],
    field: "command",
    pattern: /\|\|/,
    level: "medium",
    description: "OR chaining (||) — runs next command on failure",
  },
  {
    id: "semicolon",
    category: "shell-operator",
    tools: ["bash"],
    field: "command",
    pattern: /;\s*\S/,
    level: "medium",
    description: "Semicolon command separator",
  },
  {
    id: "subshell",
    category: "shell-operator",
    tools: ["bash"],
    field: "command",
    pattern: /\$\(/,
    level: "medium",
    description: "Command substitution $(...)",
  },
  {
    id: "backtick",
    category: "shell-operator",
    tools: ["bash"],
    field: "command",
    pattern: /`/,
    level: "medium",
    description: "Backtick command substitution",
  },
  {
    id: "process-sub",
    category: "shell-operator",
    tools: ["bash"],
    field: "command",
    pattern: /<\(|>\(/,
    level: "medium",
    description: "Process substitution <(...) or >(...)",
  },
];

// ─── Bash: Redirection ─────────────────────────────────────────────
// Output redirection can write to arbitrary files, bypassing write tool.

const redirection: ThreatDescriptor[] = [
  {
    id: "output-redirect",
    category: "redirection",
    tools: ["bash"],
    field: "command",
    pattern: /\d?>{1,2}\s/,
    level: "medium",
    description: "Output redirection (> or >>) — writes to arbitrary files",
  },
  {
    id: "fd-redirect",
    category: "redirection",
    tools: ["bash"],
    field: "command",
    pattern: /\d>&/,
    level: "medium",
    description: "File descriptor redirection",
  },
  {
    id: "heredoc",
    category: "redirection",
    tools: ["bash"],
    field: "command",
    pattern: /<<[-~]?\s*\w+/,
    level: "medium",
    description: "Heredoc — multiline input, can write to files",
  },
];

// ─── Bash: Meta-Execution ───────────────────────────────────────────
// Indirect command execution — almost always dangerous in agent context.

const metaExecution: ThreatDescriptor[] = [
  {
    id: "eval",
    category: "meta-execution",
    tools: ["bash"],
    field: "command",
    pattern: /\beval\b/,
    level: "high",
    description: "eval — executes arbitrary string as command",
  },
  {
    id: "source",
    category: "meta-execution",
    tools: ["bash"],
    field: "command",
    pattern: /\bsource\b|\.\s+\//,
    level: "high",
    description: "source/dot — executes file contents in current shell",
  },
  {
    id: "exec",
    category: "meta-execution",
    tools: ["bash"],
    field: "command",
    pattern: /\bexec\b/,
    level: "high",
    description: "exec — replaces current process",
  },
  {
    id: "xargs-sh",
    category: "meta-execution",
    tools: ["bash"],
    field: "command",
    pattern: /\bxargs\b.*\b(sh|bash|zsh)\b/,
    level: "high",
    description: "xargs piped to shell — indirect execution",
  },
];

// ─── Bash: Encoding/Obfuscation ────────────────────────────────────
// Commands can be hidden via encoding to bypass pattern matching.

const encoding: ThreatDescriptor[] = [
  {
    id: "base64-decode",
    category: "encoding",
    tools: ["bash"],
    field: "command",
    pattern: /base64\s+(-d|--decode)/,
    level: "high",
    description: "Base64 decode — can hide arbitrary commands",
  },
  {
    id: "xxd-reverse",
    category: "encoding",
    tools: ["bash"],
    field: "command",
    pattern: /\bxxd\b.*-r/,
    level: "high",
    description: "Hex decode via xxd — can hide commands",
  },
  {
    id: "printf-hex",
    category: "encoding",
    tools: ["bash"],
    field: "command",
    pattern: /printf\s+.*\\x[0-9a-fA-F]/,
    level: "medium",
    description: "Printf hex escapes — potential obfuscation",
  },
];

// ─── Bash: Network ──────────────────────────────────────────────────
// Network commands can exfiltrate data.

const network: ThreatDescriptor[] = [
  {
    id: "curl",
    category: "network",
    tools: ["bash"],
    field: "command",
    pattern: /\bcurl\b/,
    level: "medium",
    description: "curl — can send/receive data over network",
  },
  {
    id: "wget",
    category: "network",
    tools: ["bash"],
    field: "command",
    pattern: /\bwget\b/,
    level: "medium",
    description: "wget — can download/upload data",
  },
  {
    id: "netcat",
    category: "network",
    tools: ["bash"],
    field: "command",
    pattern: /\b(nc|ncat|netcat)\b/,
    level: "high",
    description: "netcat — raw network socket, high exfiltration risk",
  },
  {
    id: "scp",
    category: "network",
    tools: ["bash"],
    field: "command",
    pattern: /\bscp\b/,
    level: "medium",
    description: "scp — secure copy over network",
  },
  {
    id: "rsync",
    category: "network",
    tools: ["bash"],
    field: "command",
    pattern: /\brsync\b/,
    level: "medium",
    description: "rsync — file sync, can send data remotely",
  },
  {
    id: "ssh-cmd",
    category: "network",
    tools: ["bash"],
    field: "command",
    pattern: /\bssh\b(?!-keygen)/,
    level: "medium",
    description: "ssh — remote command execution",
  },
];

// ─── Bash: Environment Exposure ─────────────────────────────────────

const envExposure: ThreatDescriptor[] = [
  {
    id: "env-dump",
    category: "env-exposure",
    tools: ["bash"],
    field: "command",
    pattern: /\b(env|printenv)\b/,
    level: "medium",
    description: "Environment variable dump — may expose API keys",
  },
  {
    id: "proc-environ",
    category: "env-exposure",
    tools: ["bash"],
    field: "command",
    pattern: /\/proc\/.*\/environ/,
    level: "high",
    description: "/proc environ — exposes all process environment variables",
  },
];

// ─── Bash: Privilege Escalation ─────────────────────────────────────

const privilegeEscalation: ThreatDescriptor[] = [
  {
    id: "sudo",
    category: "privilege-escalation",
    tools: ["bash"],
    field: "command",
    pattern: /\bsudo\b/,
    level: "high",
    description: "sudo — runs command as root",
  },
  {
    id: "su",
    category: "privilege-escalation",
    tools: ["bash"],
    field: "command",
    pattern: /\bsu\s/,
    level: "high",
    description: "su — switch user",
  },
  {
    id: "doas",
    category: "privilege-escalation",
    tools: ["bash"],
    field: "command",
    pattern: /\bdoas\b/,
    level: "high",
    description: "doas — privilege escalation",
  },
  {
    id: "chmod",
    category: "privilege-escalation",
    tools: ["bash"],
    field: "command",
    pattern: /\bchmod\b/,
    level: "medium",
    description: "chmod — changes file permissions",
  },
  {
    id: "chown",
    category: "privilege-escalation",
    tools: ["bash"],
    field: "command",
    pattern: /\bchown\b/,
    level: "medium",
    description: "chown — changes file ownership",
  },
  {
    id: "rm-recursive",
    category: "privilege-escalation",
    tools: ["bash"],
    field: "command",
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\b/,
    level: "high",
    description: "Recursive file deletion",
  },
];

// ─── Read: Sensitive Files ──────────────────────────────────────────

const sensitiveFileReads: ThreatDescriptor[] = [
  {
    id: "read-cert-key",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /\.(pem|key|p12|pfx|keystore|jks)$/i,
    level: "high",
    description: "Certificate or private key file",
  },
  {
    id: "read-env-file",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /\.env($|\.)/i,
    level: "medium",
    description: "Environment file (.env)",
  },
  {
    id: "read-ssh-key",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /id_(rsa|ed25519|ecdsa|dsa)$/i,
    level: "high",
    description: "SSH private key",
  },
  {
    id: "read-ssh-dir",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /\/\.ssh\//,
    level: "medium",
    description: "SSH directory",
  },
  {
    id: "read-aws-dir",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /\/\.aws\//,
    level: "medium",
    description: "AWS credentials directory",
  },
  {
    id: "read-gnupg-dir",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /\/\.gnupg\//,
    level: "medium",
    description: "GnuPG directory",
  },
  {
    id: "read-system-auth",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /\/etc\/(shadow|passwd|sudoers)/,
    level: "high",
    description: "System authentication file",
  },
  {
    id: "read-proc-sensitive",
    category: "sensitive-file",
    tools: ["read"],
    field: "path",
    pattern: /\/proc\/.*\/(environ|maps|cmdline)/,
    level: "high",
    description: "Sensitive proc filesystem entry",
  },
];

// ─── Read: Path Traversal ───────────────────────────────────────────

const pathTraversal: ThreatDescriptor[] = [
  {
    id: "path-traversal",
    category: "path-traversal",
    tools: ["read", "write", "edit"],
    field: "path",
    pattern: /\.\.(?:\/|$)/,
    level: "medium",
    description: "Path traversal (../ or .. at end) — may escape allowed directories",
  },
];

// ─── Write/Edit: Dangerous Paths ────────────────────────────────────
// Writing to these locations can enable arbitrary code execution.

const dangerousWritePaths: ThreatDescriptor[] = [
  {
    id: "write-shell-config",
    category: "dangerous-path",
    tools: ["write", "edit"],
    field: "path",
    pattern: /\.(bashrc|bash_profile|profile|zshrc|zprofile|zshenv)$/,
    level: "high",
    description: "Shell config file — executed on shell start",
  },
  {
    id: "write-cron",
    category: "dangerous-path",
    tools: ["write", "edit"],
    field: "path",
    pattern: /cron/i,
    level: "high",
    description: "Cron-related path — scheduled execution",
  },
  {
    id: "write-systemd",
    category: "dangerous-path",
    tools: ["write", "edit"],
    field: "path",
    pattern: /systemd/i,
    level: "high",
    description: "Systemd unit — service execution",
  },
  {
    id: "write-git-hook",
    category: "dangerous-path",
    tools: ["write", "edit"],
    field: "path",
    pattern: /\.git\/hooks\//,
    level: "high",
    description: "Git hook — executed on git operations",
  },
  {
    id: "write-ssh-config",
    category: "dangerous-path",
    tools: ["write", "edit"],
    field: "path",
    pattern: /\.ssh\/(authorized_keys|config)$/,
    level: "high",
    description: "SSH config — controls remote access",
  },
  {
    id: "write-etc",
    category: "dangerous-path",
    tools: ["write", "edit"],
    field: "path",
    pattern: /^\/etc\//,
    level: "high",
    description: "System config directory",
  },
];

// ─── Export All ──────────────────────────────────────────────────────

export const ALL_THREAT_DESCRIPTORS: ThreatDescriptor[] = [
  ...shellOperators,
  ...redirection,
  ...metaExecution,
  ...encoding,
  ...network,
  ...envExposure,
  ...privilegeEscalation,
  ...sensitiveFileReads,
  ...pathTraversal,
  ...dangerousWritePaths,
];
