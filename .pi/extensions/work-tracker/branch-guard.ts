import { resolve } from "node:path";
import { getCurrentBranch as gitGetCurrentBranch } from "../_shared/git";
import type { BranchGuardResult, WorkTrackerConfig } from "./types";

/**
 * BranchGuard — detects and blocks git push commands targeting protected branches.
 *
 * Handles:
 *   git push origin main               — explicit protected branch
 *   git push origin master             — same for master
 *   git push origin +main              — force push
 *   git push origin HEAD:main          — refspec push
 *   git push / git push origin         — bare push when current branch is protected (runtime check)
 *   git checkout -b / git switch -c    — block new branch in shared main working tree
 *
 * Note: blocking bare `git commit` is not feasible — the tool_call hook only sees
 * the command string, not the working directory, so CWD-dependent checks are
 * unreliable and produce false positives on branch names or echo strings containing
 * the word "commit".
 */
export class BranchGuard {
  private readonly protectedBranches: string[];
  private readonly guardedRepos: string[];

  constructor(config: WorkTrackerConfig) {
    this.protectedBranches = config.protectedBranches;
    this.guardedRepos = config.guardedRepos;
  }

  check(command: string): BranchGuardResult {
    // ── Checkout guard: block branch creation in the main working tree ──
    const checkoutResult = this.checkCheckout(command);
    if (checkoutResult.shouldBlock) return checkoutResult;

    if (!this.isGitPush(command)) {
      return { shouldBlock: false };
    }

    // Check for explicit protected branch in the push command.
    // If the command includes -C <path>, only block if that path is a guarded repo.
    // This allows initial pushes to main on unguarded repos (e.g. new projects).
    const explicitRepo = this.extractRepoCFlag(command);
    const isGuardedRepo = explicitRepo === null || this.guardedRepos.some(
      (r) => resolve(r) === resolve(explicitRepo),
    );

    if (isGuardedRepo) {
      for (const branch of this.protectedBranches) {
        if (this.targetsProtectedBranch(command, branch)) {
          return {
            shouldBlock: true,
            targetBranch: branch,
            reason: this.buildReason(branch),
          };
        }
      }
    }

    // For bare push (no explicit branch), check if any guarded repo is on a protected branch
    if (this.isBareGitPush(command)) {
      for (const repoPath of this.guardedRepos) {
        const current = this.getCurrentBranch(repoPath);
        if (current && this.protectedBranches.includes(current)) {
          return {
            shouldBlock: true,
            targetBranch: current,
            reason: this.buildReason(current, repoPath),
          };
        }
      }
    }

    return { shouldBlock: false };
  }

  getCurrentBranch(repoPath: string): string | null {
    return gitGetCurrentBranch(repoPath);
  }

  /**
   * Extracts the path from a `-C <path>` flag in a git command.
   * Returns null if no -C flag is present.
   */
  private extractRepoCFlag(command: string): string | null {
    const m = command.match(/\bgit\s+-C\s+(\S+)/);
    return m ? m[1] : null;
  }

  /**
   * Detects `git checkout -b` or `git switch -c` in the main working tree of a
   * guarded repo and blocks with a worktree suggestion. Concurrent sessions share
   * the main tree's HEAD, index, and working files — checking out a branch there
   * causes cross-session collisions.
   */
  private checkCheckout(command: string): BranchGuardResult {
    if (!this.isNewBranchCheckout(command)) return { shouldBlock: false };

    // If the command has -C <path>, check if that path is a guarded repo
    const explicitRepo = this.extractRepoCFlag(command);
    if (explicitRepo !== null) {
      const isGuarded = this.guardedRepos.some(
        (r) => resolve(r) === resolve(explicitRepo),
      );
      if (!isGuarded) return { shouldBlock: false };
    }

    // Extract the branch name from the command
    const branch = this.extractNewBranchName(command);
    const branchSlug = branch ?? "<branch>";

    // Derive a worktree path suggestion from the relevant repo
    const repoPath = explicitRepo ?? this.guardedRepos[0];
    const repoName = repoPath ? resolve(repoPath).split("/").pop() ?? "repo" : "repo";
    const tmpPath = `/tmp/${repoName}-${branchSlug}`;

    return {
      shouldBlock: true,
      targetBranch: branch ?? undefined,
      reason: [
        "⛔ Don't checkout branches in the main working tree — concurrent sessions collide.",
        "",
        "Use a worktree instead:",
        `  git worktree add ${tmpPath} -b ${branchSlug}`,
        `  cd ${tmpPath}`,
        "",
        "See CONTRIBUTING.md § Worktree Isolation for details.",
      ].join("\n"),
    };
  }

  /** Matches `git checkout -b <name>` and `git switch -c/-C <name>` */
  private isNewBranchCheckout(command: string): boolean {
    return (
      /\bgit\b.*\bcheckout\b.*\s-b\b/.test(command) ||
      /\bgit\b.*\bswitch\b.*\s-[cC]\b/.test(command)
    );
  }

  /** Extracts the branch name from a checkout -b or switch -c command */
  private extractNewBranchName(command: string): string | null {
    const m = command.match(/\b(?:checkout\s+-b|switch\s+-[cC])\s+(\S+)/);
    return m ? m[1] : null;
  }

  private isGitPush(command: string): boolean {
    // Match both `git push` and `git -C <path> push` (flags may appear before push)
    return /\bgit\b.*\bpush\b/.test(command);
  }

  /**
   * Bare push: `git push` or `git push origin` — no explicit branch ref.
   * These implicitly push the current branch, so we need a runtime check.
   */
  private isBareGitPush(command: string): boolean {
    // Strip `git [flags] push` preamble (handles `git push` and `git -C <path> push`)
    const stripped = command
      .replace(/\bgit\b.*?\bpush\b/, "")
      .replace(/\s+--?\w[\w-]*/g, "")
      .trim();
    // If nothing remains, or only a remote name remains: bare push
    const tokens = stripped.split(/\s+/).filter(Boolean);
    return tokens.length <= 1;
  }

  /**
   * Returns true if the push command explicitly targets the given protected branch.
   * Uses token-level matching to avoid false positives on branch names containing
   * a protected name as a substring (e.g. "maintain" should not match "main").
   */
  private targetsProtectedBranch(command: string, branch: string): boolean {
    const e = this.escapeRe(branch);
    // Match branch as a whitespace-delimited token, optionally prefixed with + (force push)
    // or as the destination in a refspec (HEAD:main, refs/heads/main)
    const patterns = [
      new RegExp(`(?:^|\\s)\\+?${e}(?:\\s|$)`),          // plain or force: main / +main
      new RegExp(`(?:^|\\s)(?:[\\w/]+):${e}(?:\\s|$)`),  // refspec dst: HEAD:main
    ];
    return patterns.some((p) => p.test(command));
  }

  private buildReason(branch: string, repoPath?: string): string {
    const resolvedPath = repoPath ? resolve(repoPath) : undefined;
    const repoName = resolvedPath ? (resolvedPath.split("/").pop() ?? "repo") : "repo";
    const repoHint = repoPath ? ` (${repoName})` : "";
    const tmpPath = `/tmp/${repoName}-<name>`;
    const absPath = resolvedPath ?? "<repo-root>";
    return [
      `⛔ Direct push to \`${branch}\`${repoHint} is blocked.`,
      "",
      "Use a worktree for branch work:",
      `  git worktree add ${tmpPath} -b feat/<name>`,
      `  cd ${tmpPath}`,
      `  git push -u origin feat/<name>`,
      "",
      "Merge back when ready:",
      `  cd ${absPath} && git merge --no-ff feat/<name>`,
    ].join("\n");
  }

  private escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
