import { existsSync } from "node:fs";
import { relative } from "node:path";
import { gitSync } from "../_shared/git";

export const CleanupDisposition = {
  Safe: "safe",
  NeedsForce: "needs-force",
  Skipped: "skipped",
} as const;
export type CleanupDisposition = (typeof CleanupDisposition)[keyof typeof CleanupDisposition];

export const CleanupTargetKind = {
  Worktree: "worktree",
  Branch: "branch",
} as const;
type CleanupTargetKind = (typeof CleanupTargetKind)[keyof typeof CleanupTargetKind];

const DeleteMode = {
  Safe: "safe",
  Force: "force",
} as const;
type DeleteMode = (typeof DeleteMode)[keyof typeof DeleteMode];

const MergeState = {
  Merged: "merged",
  RemoteGone: "remote-gone",
  NotMerged: "not-merged",
} as const;
type MergeState = (typeof MergeState)[keyof typeof MergeState];

export interface CleanupOptions {
  apply: boolean;
  force: boolean;
  fetch: boolean;
  baseRef?: string;
  repoPath?: string;
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
}

interface CleanupTarget {
  kind: CleanupTargetKind;
  branch: string;
  path?: string;
  disposition: CleanupDisposition;
  proof: string[];
  reason?: string;
  deleteMode?: DeleteMode;
}

export interface CleanupPlan {
  repoRoot: string;
  baseRef: string;
  currentBranch: string | null;
  protectedBranches: string[];
  targets: CleanupTarget[];
  warnings: string[];
}

const PROTECTED_BRANCHES = ["main", "master", "develop", "dev", "prod", "production"];

export function parseCleanupArgs(args: string | undefined): CleanupOptions {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  return {
    apply: tokens.includes("apply") || tokens.includes("--apply"),
    force: tokens.includes("--force") || tokens.includes("force"),
    fetch: !tokens.includes("--no-fetch"),
    baseRef: valueAfter(tokens, "--base") ?? valueAfterPrefix(tokens, "--base="),
    repoPath: valueAfter(tokens, "--repo") ?? valueAfterPrefix(tokens, "--repo=") ?? positionalRepoPath(tokens),
  };
}

function positionalRepoPath(tokens: string[]): string | undefined {
  const valuesForFlags = new Set([valueAfter(tokens, "--base"), valueAfter(tokens, "--repo")].filter(Boolean));
  return tokens.find(
    (token) =>
      !["apply", "--apply", "force", "--force", "--no-fetch"].includes(token) &&
      !token.startsWith("--base=") &&
      !token.startsWith("--repo=") &&
      !token.startsWith("--") &&
      !valuesForFlags.has(token),
  );
}

function valueAfter(tokens: string[], flag: string): string | undefined {
  const idx = tokens.indexOf(flag);
  if (idx === -1) return undefined;
  return tokens[idx + 1];
}

function valueAfterPrefix(tokens: string[], prefix: string): string | undefined {
  return tokens.find((token) => token.startsWith(prefix))?.slice(prefix.length);
}

export function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | undefined;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      if (current?.path) entries.push({ path: current.path, head: current.head, branch: current.branch, detached: !current.branch });
      current = undefined;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    switch (key) {
      case "worktree":
        if (current?.path) entries.push({ path: current.path, head: current.head, branch: current.branch, detached: !current.branch });
        current = { path: value };
        break;
      case "HEAD":
        if (current) current.head = value;
        break;
      case "branch":
        if (current) current.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        if (current) current.detached = true;
        break;
      default:
        break;
    }
  }
  if (current?.path) entries.push({ path: current.path, head: current.head, branch: current.branch, detached: !current.branch });
  return entries;
}

export function formatCleanupPlan(plan: CleanupPlan, applied: boolean): string {
  const safe = plan.targets.filter((target) => target.disposition === CleanupDisposition.Safe);
  const needsForce = plan.targets.filter((target) => target.disposition === CleanupDisposition.NeedsForce);
  const skipped = plan.targets.filter((target) => target.disposition === CleanupDisposition.Skipped);
  const lines: string[] = [];

  lines.push(`${applied ? "Cleanup applied" : "Cleanup plan"} for ${plan.repoRoot}`);
  lines.push(`base: ${plan.baseRef}`);
  if (plan.currentBranch) lines.push(`current branch: ${plan.currentBranch}`);
  lines.push("");

  appendSection(lines, applied ? "Removed" : "Safe", safe);
  appendSection(lines, "Needs --force", needsForce);
  appendSection(lines, "Skipped", skipped);

  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  if (!applied) {
    lines.push("Run `/cleanup apply` to remove safe targets. Run `/cleanup apply --force` to also remove targets whose remote branch is gone but whose commits are not ancestors of the base ref.");
  }
  return lines.join("\n").trimEnd();
}

function appendSection(lines: string[], title: string, targets: CleanupTarget[]) {
  lines.push(`${title}:`);
  if (targets.length === 0) {
    lines.push("- none");
    lines.push("");
    return;
  }
  for (const target of targets) {
    const location = formatTargetLocation(target);
    lines.push(`- ${location}`);
    lines.push(`  branch: ${target.branch}`);
    if (target.reason) lines.push(`  reason: ${target.reason}`);
    for (const proof of target.proof) lines.push(`  proof: ${proof}`);
  }
  lines.push("");
}

function formatTargetLocation(target: CleanupTarget): string {
  switch (target.kind) {
    case CleanupTargetKind.Worktree:
      return `worktree ${target.path}`;
    case CleanupTargetKind.Branch:
      return `branch ${target.branch}`;
  }
}

export function buildCleanupPlan(cwd: string, options: CleanupOptions): CleanupPlan {
  const repoRoot = resolveRepoRoot(options.repoPath ?? cwd);
  const baseRef = options.baseRef ?? resolveDefaultBaseRef(repoRoot);
  const currentBranch = gitOutput(repoRoot, ["branch", "--show-current"]) || null;
  const warnings: string[] = [];

  if (options.fetch) {
    const fetched = gitSync(repoRoot, ["fetch", "--prune", "origin"], 30_000);
    if (fetched.status !== 0) warnings.push(`git fetch --prune origin failed: ${firstLine(fetched.stderr || fetched.stdout)}`);
  }

  const worktrees = parseWorktreePorcelain(gitOutput(repoRoot, ["worktree", "list", "--porcelain"]));
  const activeBranches = new Set(worktrees.map((entry) => entry.branch).filter(Boolean) as string[]);
  const targets: CleanupTarget[] = [];

  for (const entry of worktrees) {
    if (samePath(entry.path, repoRoot)) continue;
    if (!entry.branch) {
      targets.push({
        kind: CleanupTargetKind.Worktree,
        branch: "(detached)",
        path: entry.path,
        disposition: CleanupDisposition.Skipped,
        reason: "detached worktree",
        proof: [],
      });
      continue;
    }
    targets.push(classifyTarget(repoRoot, baseRef, entry.branch, entry.path, CleanupTargetKind.Worktree));
  }

  for (const branch of listLocalBranches(repoRoot)) {
    if (activeBranches.has(branch)) continue;
    if (branch === currentBranch) continue;
    const target = classifyTarget(repoRoot, baseRef, branch, undefined, CleanupTargetKind.Branch);
    if (target.disposition !== CleanupDisposition.Skipped || target.reason !== "protected branch") targets.push(target);
  }

  return { repoRoot, baseRef, currentBranch, protectedBranches: PROTECTED_BRANCHES, targets, warnings };
}

export function applyCleanupPlan(plan: CleanupPlan, options: CleanupOptions): string[] {
  if (!options.apply) return [];
  const actions: string[] = [];
  const removable = plan.targets.filter(
    (target) => target.disposition === CleanupDisposition.Safe || (options.force && target.disposition === CleanupDisposition.NeedsForce),
  );

  for (const target of removable.filter((candidate) => candidate.kind === CleanupTargetKind.Worktree)) {
    if (!target.path || !existsSync(target.path)) continue;
    const result = gitSync(plan.repoRoot, ["worktree", "remove", target.path], 30_000);
    if (result.status !== 0) throw new Error(`failed to remove worktree ${target.path}: ${result.stderr || result.stdout}`);
    actions.push(`removed worktree ${target.path}`);
  }

  const deletedBranches = new Set<string>();
  for (const target of removable) {
    if (deletedBranches.has(target.branch)) continue;
    if (!localBranchExists(plan.repoRoot, target.branch)) continue;
    const mode = deleteFlagForDisposition(target.disposition);
    const result = gitSync(plan.repoRoot, ["branch", mode, target.branch], 30_000);
    if (result.status !== 0) throw new Error(`failed to delete branch ${target.branch}: ${result.stderr || result.stdout}`);
    deletedBranches.add(target.branch);
    actions.push(`deleted branch ${target.branch}`);
  }

  return actions;
}

function deleteFlagForDisposition(disposition: CleanupDisposition): "-d" | "-D" {
  switch (disposition) {
    case CleanupDisposition.Safe:
      return "-d";
    case CleanupDisposition.NeedsForce:
    case CleanupDisposition.Skipped:
      return "-D";
  }
}

function classifyTarget(repoRoot: string, baseRef: string, branch: string, path: string | undefined, kind: CleanupTargetKind): CleanupTarget {
  if (isProtectedBranch(branch)) {
    return { kind, branch, path, disposition: CleanupDisposition.Skipped, reason: "protected branch", proof: [] };
  }
  if (path && isDirty(path)) {
    return { kind, branch, path, disposition: CleanupDisposition.Skipped, reason: "worktree has uncommitted changes", proof: [] };
  }

  const branchRef = `refs/heads/${branch}`;
  const branchMerged = isAncestor(repoRoot, branchRef, baseRef);
  const headMerged = path ? isAncestor(path, "HEAD", baseRef) : branchMerged;
  const remoteGone = !remoteBranchExists(repoRoot, branch);
  const proof: string[] = [];

  if (branchMerged) proof.push(`${branchRef} is ancestor of ${baseRef}`);
  if (headMerged && path) proof.push(`worktree HEAD is ancestor of ${baseRef}`);
  if (remoteGone) proof.push("remote branch is gone after fetch --prune");

  switch (mergeState(branchMerged, headMerged, remoteGone)) {
    case MergeState.Merged:
      return { kind, branch, path, disposition: CleanupDisposition.Safe, proof, deleteMode: DeleteMode.Safe };
    case MergeState.RemoteGone:
      return {
        kind,
        branch,
        path,
        disposition: CleanupDisposition.NeedsForce,
        reason: "remote branch is gone, but local commits are not ancestors of the base ref (common after squash merge)",
        proof,
        deleteMode: DeleteMode.Force,
      };
    case MergeState.NotMerged:
      return { kind, branch, path, disposition: CleanupDisposition.Skipped, reason: `not proven merged into ${baseRef}`, proof };
  }
}

function mergeState(branchMerged: boolean, headMerged: boolean, remoteGone: boolean): MergeState {
  if (branchMerged || headMerged) return MergeState.Merged;
  if (remoteGone) return MergeState.RemoteGone;
  return MergeState.NotMerged;
}

function resolveRepoRoot(cwd: string): string {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error(`${cwd} is not inside a git repository`);
  return root;
}

function resolveDefaultBaseRef(repoRoot: string): string {
  const originHead = gitOutput(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  return originHead || "origin/main";
}

function listLocalBranches(repoRoot: string): string[] {
  return gitOutput(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function localBranchExists(repoRoot: string, branch: string): boolean {
  return gitSync(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0;
}

function remoteBranchExists(repoRoot: string, branch: string): boolean {
  return gitSync(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).status === 0;
}

function isAncestor(cwd: string, maybeAncestor: string, descendant: string): boolean {
  return gitSync(cwd, ["merge-base", "--is-ancestor", maybeAncestor, descendant]).status === 0;
}

function isDirty(cwd: string): boolean {
  return gitOutput(cwd, ["status", "--porcelain"]).trim().length > 0;
}

function gitOutput(cwd: string, args: string[]): string {
  const result = gitSync(cwd, args);
  return result.status === 0 ? result.stdout.trim() : "";
}

function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.includes(branch) || branch.startsWith("release/");
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === "";
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim())?.trim() ?? "unknown error";
}

