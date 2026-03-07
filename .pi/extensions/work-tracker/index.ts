/**
 * Work Tracker Extension — entry point.
 *
 * Provides two capabilities:
 *   1. Branch guard  — blocks git push to protected branches (tool_call hook)
 *   2. Context       — injects git branch + dirty status before root agent turns
 *
 * Subagent detection: if PI_AGENT_ID env var is set, context injection is skipped
 * (subagents don't need this context, and injecting it wastes tokens).
 *
 * Config via env vars:
 *   WORK_TRACKER_REPOS      — comma-separated repo paths (default: pi-env, nix-config)
 *   WORK_TRACKER_PROTECTED  — comma-separated protected branches (default: main, master)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";

import { BranchGuard } from "./branch-guard";
import type { WorkTrackerConfig } from "./types";

function loadConfig(): WorkTrackerConfig {
  const guardedRepos = process.env.WORK_TRACKER_REPOS
    ? process.env.WORK_TRACKER_REPOS.split(",").map((s) => s.trim())
    : ["/mnt/tank/code/pi-env", "/mnt/tank/code/nix-config"];

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

  // ─── 2. Initial widget on session start ───────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_AGENT_ID) return;
    const line = buildStatusLine();
    if (line) ctx.ui.setWidget("work-tracker", [line], { placement: "belowEditor" });
  });

  // ─── 3. Context Injection + widget refresh (root sessions only) ───
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
