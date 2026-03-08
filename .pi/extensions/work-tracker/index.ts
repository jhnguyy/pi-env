/**
 * Work Tracker Extension — entry point.
 *
 * Provides three capabilities:
 *   1. Branch guard      — blocks git push to protected branches (tool_call hook)
 *   2. Handoff cleanup   — deletes handoffs when their branch merges (tool_result hook)
 *   3. Context injection — injects git branch + dirty status before root agent turns
 *
 * Subagent detection: if PI_AGENT_ID env var is set, context injection is skipped
 * (subagents don't need this context, and injecting it wastes tokens).
 *
 * Config via env vars:
 *   WORK_TRACKER_REPOS      — comma-separated repo paths (default: pi-env only)
 *   WORK_TRACKER_PROTECTED  — comma-separated protected branches (default: main, master)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";

import { BranchGuard } from "./branch-guard";
import {
	cleanupHandoffs,
	detectMergedBranch,
	isGitPull,
	parseMergedBranches,
} from "./handoff-cleanup";
import type { WorkTrackerConfig } from "./types";

function loadConfig(): WorkTrackerConfig {
  const guardedRepos = process.env.WORK_TRACKER_REPOS
    ? process.env.WORK_TRACKER_REPOS.split(",").map((s) => s.trim())
    : ["/mnt/tank/code/pi-env"];

  const protectedBranches = process.env.WORK_TRACKER_PROTECTED
    ? process.env.WORK_TRACKER_PROTECTED.split(",").map((s) => s.trim())
    : ["main", "master"];

  return { guardedRepos, protectedBranches };
}

function getGitStatus(repoPath: string): { branch: string | null; dirty: number } {
  let branch: string | null = null;
  let dirty = 0;
  try {
    const b = spawnSync("git", ["-C", repoPath, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (b.status === 0 && b.stdout) branch = b.stdout.trim() || null;

    const s = spawnSync("git", ["-C", repoPath, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (s.status === 0 && s.stdout) {
      dirty = s.stdout.trim().split("\n").filter(Boolean).length;
    }
  } catch {
    // Ignore — repo may not exist
  }
  return { branch, dirty };
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const guard = new BranchGuard(config);

  function buildStatusLine(): string | null {
    const parts: string[] = [];
    for (const repoPath of config.guardedRepos) {
      const { branch, dirty } = getGitStatus(repoPath);
      if (!branch) continue;
      const name = repoPath.split("/").pop() ?? repoPath;
      const warn = config.protectedBranches.includes(branch) ? " ⚠️" : "";
      const dirtyNote = dirty > 0 ? ` (${dirty} uncommitted)` : "";
      parts.push(`${name}: ${branch}${warn}${dirtyNote}`);
    }
    return parts.length > 0 ? `[work-tracker] ${parts.join(" | ")}` : null;
  }

  // ─── 0. Commands ──────────────────────────────────────────────────
  pi.registerCommand("review-retros", {
    description: "Review last N session retros and propose behavioral improvements.\nUsage: /review-retros [N]  (default: last 5 retros)",
    handler: async (args, _ctx) => {
      const n = args && /^\d+$/.test(args.trim()) ? parseInt(args.trim(), 10) : 5;

      pi.sendUserMessage(
        `Review the last ${n} session retrospectives and propose behavioral improvements.\n` +
          `\n` +
          `Steps:\n` +
          `1. Read the last ${n} retro files from ~/.pi/retro/ (sorted by filename descending — newest first).\n` +
          `   Each file contains one or more sections with "### Patterns" and tagged items ([workflow],\n` +
          `   [tooling], [convention], [mistake], [knowledge]).\n` +
          `2. Read ~/.pi/agent/AGENTS.md.\n` +
          `3. Read all active skills in ~/.agents/skills/ (read each SKILL.md).\n` +
          `4. Identify recurring patterns across the retros — the same tag appearing 2 or more times\n` +
          `   with related observations.\n` +
          `5. For each recurring pattern, produce a single-rule proposal:\n` +
          `   - What was observed and how often\n` +
          `   - Proposed change: one AGENTS.md line, one skill rule, or one convention note\n` +
          `   - Exact diff (what to add/remove)\n` +
          `   - Rationale\n` +
          `   If the change is too large to be a single rule, file it as a task instead — do not\n` +
          `   propose it inline.\n` +
          `6. Present each proposal one at a time and ask: "Apply this? (yes/no/modify)"\n` +
          `7. Apply accepted proposals immediately using the appropriate tool.`,
      );
    },
  });

  // ─── 1. Branch Guard ──────────────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = (event.input as Record<string, string>).command ?? "";
    const result = guard.check(command);
    if (result.shouldBlock) {
      return { block: true, reason: result.reason };
    }
    return undefined;
  });

  // ─── 2. Handoff cleanup on merge ─────────────────────────────────
  //
  // Path A — local git merge (fast-forward or merge commit):
  //   Fires when the agent runs `git merge <branch>` directly.
  //
  // Path B — git pull on a protected branch (GitHub PR merge workflow):
  //   After any git pull, checks each guarded repo. If we're on a protected
  //   branch, collects all locally-known merged branches and cleans up their
  //   handoffs. This covers the common flow: PR merges on GitHub → agent runs
  //   `git checkout main && git pull`.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || event.isError) return;

    const command = (event.input as Record<string, string>).command ?? "";
    const output = (event.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    // ── Path A: local git merge ──────────────────────────────────
    const mergedBranch = detectMergedBranch(command, output);
    if (mergedBranch) {
      const deleted = cleanupHandoffs(mergedBranch);
      if (deleted.length > 0) {
        ctx.ui.notify(
          `🧹 Merged ${mergedBranch} — deleted ${deleted.length} handoff(s): ${deleted.join(", ")}`,
          "info",
        );
      }
      return;
    }

    // ── Path B: git pull on a protected branch ───────────────────
    if (!isGitPull(command)) return;

    const allMerged = new Set<string>();
    for (const repoPath of config.guardedRepos) {
      const { branch: current } = getGitStatus(repoPath);
      if (!current || !config.protectedBranches.includes(current)) continue;

      const result = spawnSync(
        "git",
        ["-C", repoPath, "branch", "--merged", "HEAD"],
        { encoding: "utf8", timeout: 3000 },
      );
      if (result.status !== 0 || !result.stdout) continue;

      for (const branch of parseMergedBranches(result.stdout)) {
        // Exclude the protected branches themselves
        if (!config.protectedBranches.includes(branch)) {
          allMerged.add(branch);
        }
      }
    }

    if (allMerged.size === 0) return;

    const deleted = cleanupHandoffs(allMerged);
    if (deleted.length > 0) {
      ctx.ui.notify(
        `🧹 Pulled main — deleted ${deleted.length} handoff(s): ${deleted.join(", ")}`,
        "info",
      );
    }
  });

  // ─── 3. Initial widget on session start ───────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_AGENT_ID) return;
    const line = buildStatusLine();
    if (line) ctx.ui.setWidget("work-tracker", [line], { placement: "belowEditor" });
  });

  // ─── 4. Context Injection + widget refresh (root sessions only) ───
  pi.on("before_agent_start", async (_event, ctx) => {
    // Skip context injection for subagents — PI_AGENT_ID is set by pi
    // when spawning subagents via the tmux tool
    if (process.env.PI_AGENT_ID) return {};

    const line = buildStatusLine();

    // Refresh the persistent widget with latest git state
    if (line) ctx.ui.setWidget("work-tracker", [line], { placement: "belowEditor" });

    if (!line) return {};

    return {
      message: {
        customType: "work-tracker",
        content: line,
        display: false,
      },
    };
  });
}
