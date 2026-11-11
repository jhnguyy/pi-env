export interface WorkTrackerConfig {
  /** Repositories included in worktree and dirty-state checks. */
  guardedRepos: string[];
  /** Legacy configuration retained for compatibility; no handoff cleanup runs. */
  protectedBranches: string[];
}

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  addedAt: string;
  completedAt?: string;
}
