export interface WorkTrackerConfig {
  /** Repositories included in worktree, dirty-state, and handoff cleanup checks. */
  guardedRepos: string[];
  /** Base branches whose merged topic branches can trigger handoff cleanup. */
  protectedBranches: string[];
}

export interface TodoItem {
  id: number;
  text: string;
  done: boolean;
  addedAt: string;
  completedAt?: string;
}
