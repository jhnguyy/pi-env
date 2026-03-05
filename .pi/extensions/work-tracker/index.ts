/**
 * Work Tracker Extension — entry point.
 *
 * Provides three capabilities:
 *   1. Branch guard  — blocks git push to protected branches (tool_call hook)
 *   2. Work state    — tracks active task + recent history (~/.pi/work-state.json)
 *   3. Context       — injects git status + active task before each agent turn
 *   4. Retrospective — writes session summary on shutdown (~/.pi/retrospectives/)
 *
 * Config via env vars:
 *   WORK_TRACKER_REPOS      — comma-separated repo paths (default: pi-env, nix-config)
 *   WORK_TRACKER_PROTECTED  — comma-separated protected branches (default: main, master)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { BranchGuard } from "./branch-guard";
import { RetrospectiveStore } from "./retrospective";
import { WorkStateStore } from "./work-state";
import type { WorkTrackerConfig } from "./types";

function loadConfig(): WorkTrackerConfig {
  const guardedRepos = process.env.WORK_TRACKER_REPOS
    ? process.env.WORK_TRACKER_REPOS.split(",").map((s) => s.trim())
    : ["/mnt/tank/code/pi-env", "/mnt/tank/code/nix-config"];

  const protectedBranches = process.env.WORK_TRACKER_PROTECTED
    ? process.env.WORK_TRACKER_PROTECTED.split(",").map((s) => s.trim())
    : ["main", "master"];

  return {
    guardedRepos,
    protectedBranches,
    workStatePath: join(homedir(), ".pi", "work-state.json"),
    retrospectivesDir: join(homedir(), ".pi", "retrospectives"),
  };
}

function getGitStatus(
  repoPath: string
): { branch: string | null; dirty: number } {
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
  const workState = new WorkStateStore(config.workStatePath);
  const retros = new RetrospectiveStore(config.retrospectivesDir);

  let sessionStartTime = Date.now();
  let sessionId = Math.random().toString(36).slice(2, 10);

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

  // ─── 2. File tracking (tool_result) ──────────────────────────────
  pi.on("tool_result", async (event, _ctx) => {
    const writingTools = ["write", "edit", "bash"];
    if (!writingTools.includes(event.toolName)) return undefined;
    if (event.toolName === "write" || event.toolName === "edit") {
      const path = (event.input as Record<string, string>).path;
      if (path) workState.addFileTouched(path);
    }
    return undefined;
  });

  // ─── 3. Context Injection ─────────────────────────────────────────
  pi.on("before_agent_start", async (_event, _ctx) => {
    const parts: string[] = [];

    for (const repoPath of config.guardedRepos) {
      const { branch, dirty } = getGitStatus(repoPath);
      if (!branch) continue;
      const name = repoPath.split("/").pop() ?? repoPath;
      const warn = config.protectedBranches.includes(branch) ? " ⚠️" : "";
      const dirtyNote = dirty > 0 ? ` (${dirty} uncommitted)` : "";
      parts.push(`${name}: ${branch}${warn}${dirtyNote}`);
    }

    const state = workState.read();
    if (state.active) {
      parts.push(`active: ${state.active.task}`);
    }

    if (parts.length === 0) return {};

    return {
      message: {
        customType: "work-tracker",
        content: `[work-tracker] ${parts.join(" | ")}`,
        display: true,
      },
    };
  });

  // ─── 4. Session lifecycle ─────────────────────────────────────────
  pi.on("session_start", async (_event, _ctx) => {
    sessionStartTime = Date.now();
    sessionId = Math.random().toString(36).slice(2, 10);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    const state = workState.read();
    if (!state.active) return;

    const now = new Date().toISOString();
    const durationMinutes = Math.round((Date.now() - sessionStartTime) / 60000);

    retros.write({
      sessionId,
      task: state.active.task,
      branch: state.active.branch,
      repo: state.active.repo,
      outcome: "partial", // User can update via /work done before shutting down
      startedAt: state.active.startedAt,
      completedAt: now,
      durationMinutes,
      filesChanged: state.active.filesTouched,
      notes: "",
    });

    workState.complete({
      task: state.active.task,
      branch: state.active.branch,
      repo: state.active.repo,
      outcome: "partial",
      completedAt: now,
      durationMinutes,
      summary: "",
      filesChanged: state.active.filesTouched,
    });
  });

  // ─── 5. /work Command ─────────────────────────────────────────────
  pi.registerCommand("work", {
    description: [
      "Track active work. Usage:",
      "  /work              — show active task and recent history",
      "  /work start <task> — set active task description",
      "  /work done         — mark current task complete (success)",
    ].join("\n"),

    handler: async (args, ctx) => {
      const trimmed = args?.trim() ?? "";

      // /work start <task>
      if (trimmed.startsWith("start ")) {
        const task = trimmed.slice(6).trim();
        if (!task) {
          ctx.ui.notify("Usage: /work start <task description>", "warning");
          return;
        }

        // Auto-detect branch + repo
        let branch: string | null = null;
        let repo: string | null = null;
        for (const repoPath of config.guardedRepos) {
          const b = guard.getCurrentBranch(repoPath);
          if (b && !config.protectedBranches.includes(b)) {
            branch = b;
            repo = repoPath.split("/").pop() ?? repoPath;
            break;
          }
        }

        workState.setActive({
          sessionId,
          task,
          branch,
          repo,
          startedAt: new Date().toISOString(),
          filesTouched: [],
        });

        const branchLine = branch ? `\nBranch: ${branch} (${repo})` : "";
        ctx.ui.notify(`Active: ${task}${branchLine}`, "info");
        return;
      }

      // /work done
      if (trimmed === "done") {
        const state = workState.read();
        if (!state.active) {
          ctx.ui.notify("No active task.", "info");
          return;
        }
        const durationMinutes = Math.round(
          (Date.now() - sessionStartTime) / 60000
        );
        workState.complete({
          task: state.active.task,
          branch: state.active.branch,
          repo: state.active.repo,
          outcome: "success",
          completedAt: new Date().toISOString(),
          durationMinutes,
          summary: "",
          filesChanged: state.active.filesTouched,
        });
        ctx.ui.notify(`✅ Completed: ${state.active.task}`, "info");
        return;
      }

      // /work — show status
      const state = workState.read();
      const lines: string[] = ["Work Tracker", "─".repeat(44)];

      if (state.active) {
        lines.push(`\nActive: ${state.active.task}`);
        if (state.active.branch)
          lines.push(`Branch: ${state.active.branch} (${state.active.repo})`);
        lines.push(
          `Since:  ${new Date(state.active.startedAt).toLocaleTimeString()}`
        );
        if (state.active.filesTouched.length > 0) {
          lines.push(`Files:  ${state.active.filesTouched.length} touched`);
        }
      } else {
        lines.push("\n(no active task — use /work start <description>)");
      }

      if (state.recent.length > 0) {
        lines.push("\nRecent:");
        for (const r of state.recent.slice(0, 5)) {
          const icon =
            r.outcome === "success"
              ? "✅"
              : r.outcome === "partial"
                ? "🔶"
                : "❌";
          lines.push(`  ${icon} ${r.task} (${r.durationMinutes}m)`);
        }
      }

      lines.push("\nRepos:");
      for (const repoPath of config.guardedRepos) {
        const { branch, dirty } = getGitStatus(repoPath);
        if (!branch) continue;
        const name = repoPath.split("/").pop() ?? repoPath;
        const warn = config.protectedBranches.includes(branch) ? " ⚠️ on protected branch" : "";
        const dirtyNote = dirty > 0 ? ` · ${dirty} uncommitted` : "";
        lines.push(`  ${name}: ${branch}${warn}${dirtyNote}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
